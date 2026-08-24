import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  ensureSandbox,
  execCapture,
  runClaudeStreaming,
  bootstrapScriptPath,
  inContainer,
} from "./sandbox.mjs";
import { createStreamRenderer, foundPromise, paint, colors as C } from "./stream.mjs";
import { userPluginsDir } from "./paths.mjs";
import { ralphDir } from "./config.mjs";
import { detect as detectKnowledgeIndex, render as renderKnowledgeIndex, describeMcpFailure } from "./knowledge-index.mjs";

/**
 * Lê o prompt do repo e resolve os placeholders.
 *
 * `{{KNOWLEDGE_INDEX_BLOCK}}` some junto com a própria quebra de linha que o
 * segue no template (`.replaceAll` com o `\n` no padrão de busca) — é o que
 * garante que repositório sem índice produz um prompt byte a byte igual ao
 * de antes desta issue, sem linha em branco sobrando no lugar do bloco.
 */
export function buildPrompt(root, cfg) {
  const file = path.join(root, cfg.promptFile);
  if (!existsSync(file)) {
    throw new Error(`prompt não encontrado: ${cfg.promptFile} — rode 'ralph init' neste repo`);
  }
  const loops = (cfg.feedbackLoops ?? []).length
    ? cfg.feedbackLoops.map((cmd, i) => `${i + 1}. \`${cmd}\` — must pass`).join("\n")
    : "1. Discover this repo's checks (package.json scripts, Makefile, CI config) and run every one that applies.";
  const { promptBlock } = renderKnowledgeIndex(detectKnowledgeIndex(root, cfg), null);

  return readFileSync(file, "utf8")
    .replaceAll("{{PROGRESS_FILE}}", cfg.progressFile)
    .replaceAll("{{COMPLETION_PROMISE}}", cfg.completionPromise)
    .replaceAll("{{BLOCKED_PROMISE}}", cfg.blockedPromise ?? "BLOCKED")
    .replaceAll("{{FEEDBACK_LOOPS}}", loops)
    .replaceAll("{{KNOWLEDGE_INDEX_BLOCK}}\n", promptBlock);
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitConfigValue(root, key) {
  return git(root, ["config", "--get", key]);
}

/**
 * `git branch --show-current` em vez de `rev-parse HEAD`: um repo recém-criado
 * já tem branch mas ainda não tem commit, e o rev-parse falharia nele.
 */
export function currentBranch(root) {
  if (!git(root, ["rev-parse", "--is-inside-work-tree"])) return null;
  return git(root, ["branch", "--show-current"]) || "(detached)";
}

/** Roda o bootstrap dentro do sandbox se ele ainda não rodou (ou se forçado). */
export async function ensureBootstrap(name, root, { force = false } = {}) {
  if (!force) {
    const probe = await execCapture(name, ["test", "-f", "/home/agent/.claude/.ralph-bootstrap"]);
    if (probe.code === 0) return false;
  }
  const plugins = userPluginsDir();
  const env = [
    `RALPH_PLUGINS_SRC=${plugins ? inContainer(plugins) : ""}`,
    `RALPH_GIT_NAME=${gitConfigValue(root, "user.name") || "Ralph"}`,
    `RALPH_GIT_EMAIL=${gitConfigValue(root, "user.email") || "ralph@localhost"}`,
    // Sem replicar isto, o git do container compara bytes crus: um repo clonado
    // no Windows aparece com todos os arquivos "modificados" só por CRLF, e o
    // agente commita milhares de linhas de ruído.
    `RALPH_GIT_AUTOCRLF=${gitConfigValue(root, "core.autocrlf")}`,
  ];
  const res = await execCapture(name, ["env", ...env, "bash", bootstrapScriptPath()]);
  process.stdout.write(res.stdout.replace(/^/gm, "  "));
  if (res.code !== 0) {
    process.stderr.write(paint(C.red, res.stderr.replace(/^/gm, "  ")));
    throw new Error("bootstrap do sandbox falhou");
  }
  return true;
}


/**
 * Roda o `.ralph/setup.sh` do repo dentro do sandbox: é onde cada projeto
 * instala o que seus feedback loops precisam (pytest, cargo, o que for). O
 * sandbox nasce com o Claude e mais nada.
 *
 * O carimbo carrega o hash do script, então editar o setup dispara uma nova
 * execução sozinho — sem precisar lembrar do --force.
 */
export async function ensureSetup(name, root, cfg, { force = false } = {}) {
  const rel = cfg.setupScript ?? ".ralph/setup.sh";
  const script = path.join(root, rel);
  if (!existsSync(script)) return false;

  const hash = createHash("sha256").update(readFileSync(script)).digest("hex").slice(0, 16);
  const stamp = `/home/agent/.claude/.ralph-setup-${hash}`;
  if (!force) {
    const probe = await execCapture(name, ["test", "-f", stamp]);
    if (probe.code === 0) return false;
  }

  process.stdout.write(paint(C.dim, `  rodando ${rel} dentro do sandbox…\n`));
  const cmd = `cd ${shq(inContainer(root))} && bash ${shq(inContainer(script))} && touch ${shq(stamp)}`;
  const res = await execCapture(name, ["bash", "-lc", cmd]);
  process.stdout.write(res.stdout.replace(/^/gm, "  "));
  if (res.code !== 0) {
    process.stderr.write(paint(C.red, res.stderr.replace(/^/gm, "  ")));
    throw new Error(`${rel} falhou dentro do sandbox`);
  }
  return true;
}

/** Aspas simples para bash, escapando as aspas de dentro. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\''`)}'`;
}

/** Confere se o Claude dentro do sandbox está autenticado. */
export async function isLoggedIn(name) {
  const res = await execCapture(name, ["bash", "-lc", "test -s ~/.claude/.credentials.json && echo yes || echo no"]);
  return res.stdout.includes("yes");
}

/**
 * A sessão anuncia as skills que carregou no evento `init`. Se a skill que o
 * prompt invoca não está lá, o bootstrap não pegou e o loop inteiro vai rodar
 * sem as skills — falha cara e silenciosa, então avisa alto.
 */
function warnIfSkillMissing(state, cfg) {
  const required = cfg.requireSkills ?? ["mattpocock-skills:implement"];
  if (!required.length || state.skills == null) return;
  const haystack = JSON.stringify(state.skills);
  const missing = required.filter((s) => !haystack.includes(s));
  if (!missing.length) return;
  process.stdout.write(
    paint(C.yellow, `\n  ! skill ausente na sessão: ${missing.join(", ")}\n`) +
      paint(C.dim, `    o sandbox rodou sem ela. Tente 'ralph bootstrap --force'.\n`)
  );
}

/**
 * Índice de conhecimento achado em disco, mas o MCP dele não subiu na
 * sessão — o bug medido na issue #1: o `.mcp.json` do repositório alvo aponta
 * pra um servidor que falha dentro do sandbox, e sem este aviso a iteração
 * varre arquivo achando que não há índice nenhum.
 */
function warnIfIndexMcpFailed(state, cfg, root) {
  const detected = detectKnowledgeIndex(root, cfg);
  const message = describeMcpFailure(detected, state.mcpServers);
  if (!message) return;
  process.stdout.write(paint(C.yellow, `\n  ! ${message}\n`));
}

function logFile(root, iteration) {
  const dir = path.join(ralphDir(root), "logs");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${stamp}-iter-${String(iteration).padStart(2, "0")}.jsonl`);
}

/**
 * Uma iteração: contexto novo, um ticket, sai. É a propriedade que faz Ralph
 * funcionar — nada de reaproveitar sessão entre iterações.
 */
export async function runIteration(root, cfg, { iteration = 1, total = 1, prompt, extraArgs = [] }) {
  const workdir = inContainer(root);
  const jsonl = logFile(root, iteration);
  const renderer = createStreamRenderer({
    onEvent: (evt) => appendFileSync(jsonl, JSON.stringify(evt) + "\n", "utf8"),
  });

  const header = `iteração ${iteration}/${total}`;
  process.stdout.write(
    `\n${paint(C.magenta, "━".repeat(8))} ${paint(C.bold, header)} ${paint(C.dim, new Date().toLocaleTimeString())} ${paint(C.magenta, "━".repeat(8))}\n`
  );

  const { code, stderr } = await runClaudeStreaming(cfg.sandboxName, {
    workdir,
    prompt,
    model: cfg.model,
    extraArgs,
    onChunk: (chunk) => renderer.write(chunk),
  });
  const state = renderer.end();

  warnIfSkillMissing(state, cfg);
  warnIfIndexMcpFailed(state, cfg, root);

  if (code !== 0 && !state.finalResult) {
    process.stderr.write(paint(C.red, `\n  claude saiu com código ${code}\n`));
    if (stderr.trim()) process.stderr.write(paint(C.dim, stderr.trim().split("\n").slice(-8).join("\n") + "\n"));
  }

  return {
    code,
    state,
    logPath: jsonl,
    complete: foundPromise(state, cfg.completionPromise),
    blocked: foundPromise(state, cfg.blockedPromise ?? "BLOCKED"),
  };
}

/** Prepara sandbox + bootstrap + checagens antes de qualquer iteração. */
export async function prepare(root, cfg, { allowBranch = false } = {}) {
  const branch = currentBranch(root);
  if (branch && !allowBranch && (cfg.protectedBranches ?? []).includes(branch)) {
    throw new Error(
      `você está em '${branch}'. Ralph commita a cada iteração — crie uma branch ` +
        `(git switch -c ralph/<assunto>) ou passe --allow-branch para assumir o risco.`
    );
  }

  const created = await ensureSandbox(cfg.sandboxName, root, cfg);
  if (created) process.stdout.write(paint(C.dim, `  sandbox ${cfg.sandboxName} criado\n`));
  const bootstrapped = await ensureBootstrap(cfg.sandboxName, root);
  if (!bootstrapped) process.stdout.write(paint(C.dim, `  sandbox ${cfg.sandboxName} pronto\n`));
  await ensureSetup(cfg.sandboxName, root, cfg);

  if (!(await isLoggedIn(cfg.sandboxName))) {
    throw new Error(
      `o Claude dentro do sandbox '${cfg.sandboxName}' não está autenticado.\n` +
        `  Rode 'ralph login' e use /login lá dentro (uma vez por sandbox).`
    );
  }
  return { branch };
}

/** Loop AFK: N iterações de contexto novo até a promise ou o teto. */
export async function runLoop(root, cfg, { iterations, allowBranch = false, extraArgs = [] }) {
  const { branch } = await prepare(root, cfg, { allowBranch });
  const prompt = buildPrompt(root, cfg);

  process.stdout.write(
    `\n${paint(C.bold, "Ralph")} ${paint(C.dim, `· ${path.basename(root)} · branch ${branch ?? "—"} · modelo ${cfg.model} · até ${iterations} iterações`)}\n`
  );

  const started = Date.now();
  let cost = 0;
  for (let i = 1; i <= iterations; i++) {
    const result = await runIteration(root, cfg, { iteration: i, total: iterations, prompt, extraArgs });
    cost += result.state.costUsd ?? 0;

    if (result.complete) {
      process.stdout.write(paint(C.green, `\n✓ backlog concluído na iteração ${i}.\n`));
      return summary(i, cost, started, "complete");
    }
    if (result.blocked) {
      process.stdout.write(paint(C.yellow, `\n■ Ralph travou na iteração ${i} e pediu um humano.\n`));
      return summary(i, cost, started, "blocked");
    }
    if (result.code !== 0) {
      process.stdout.write(paint(C.red, `\n✗ iteração ${i} falhou. Log: ${path.relative(root, result.logPath)}\n`));
      return summary(i, cost, started, "error");
    }
    if (cfg.cooldownSeconds > 0 && i < iterations) {
      await new Promise((r) => setTimeout(r, cfg.cooldownSeconds * 1000));
    }
  }
  process.stdout.write(paint(C.yellow, `\n⏱ teto de ${iterations} iterações atingido sem a promise.\n`));
  return summary(iterations, cost, started, "max-iterations");
}

function summary(iterations, cost, started, status) {
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  process.stdout.write(
    paint(C.dim, `  ${iterations} iterações · ${mins} min · ${cost ? `$${cost.toFixed(4)}` : "custo não reportado"}\n`)
  );
  return { status, iterations, cost };
}

