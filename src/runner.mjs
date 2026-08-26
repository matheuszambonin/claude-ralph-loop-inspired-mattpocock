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
import { createStreamRenderer, foundPromise, paint, colors as C, accumulateModelUsage, formatCostByModel } from "./stream.mjs";
import { userPluginsDir, userClaudeDir } from "./paths.mjs";
import { parse as parseCredentials, verdict as credentialVerdict, isAuthFailure, authFailureAdvice } from "./credentials.mjs";
import { ralphDir } from "./config.mjs";
import {
  detect as detectKnowledgeIndex,
  render as renderKnowledgeIndex,
  probe as probeKnowledgeIndex,
  needsOllamaProbe,
  describeMcpFailure,
  readTargetMcpConfig,
  resolveEmbeddingEnv,
} from "./knowledge-index.mjs";
import { buildOrientationPrompt, buildOrientationAgent } from "./orientation.mjs";
import {
  resolve as resolveProvider,
  renderEnv as renderProviderEnv,
  requiresAnthropicAuth,
  probeBoth as probeProviderBoth,
  describeDegradation as describeProviderDegradation,
} from "./provider.mjs";

function feedbackLoopsBlock(cfg) {
  return (cfg.feedbackLoops ?? []).length
    ? cfg.feedbackLoops.map((cmd, i) => `${i + 1}. \`${cmd}\` — must pass`).join("\n")
    : "1. Discover this repo's checks (package.json scripts, Makefile, CI config) and run every one that applies.";
}

/** Pura: template do prompt de iteração entra, prompt resolvido sai. Sem fs, sem Docker. */
export function renderPrompt(template, cfg) {
  return template
    .replaceAll("{{PROGRESS_FILE}}", cfg.progressFile)
    .replaceAll("{{COMPLETION_PROMISE}}", cfg.completionPromise)
    .replaceAll("{{BLOCKED_PROMISE}}", cfg.blockedPromise)
    .replaceAll("{{FEEDBACK_LOOPS}}", feedbackLoopsBlock(cfg));
}

/**
 * Lê o prompt do repo e resolve os placeholders. Desde a issue #10 a
 * Orientação (e o bloco do índice de conhecimento que ela consulta) mora no
 * prompt do subagente, não aqui — este prompt não tem mais o que resolver
 * além do que `renderPrompt` já cobre.
 */
export function buildPrompt(root, cfg) {
  const file = path.join(root, cfg.promptFile);
  if (!existsSync(file)) {
    throw new Error(`prompt não encontrado: ${cfg.promptFile} — rode 'ralph init' neste repo`);
  }
  return renderPrompt(readFileSync(file, "utf8"), cfg);
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
    // Bootstrap neutraliza os hooks do repositório alvo aqui dentro
    // (ADR-0002) — precisa do caminho de container, não do host.
    `RALPH_REPO_PATH=${inContainer(root)}`,
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

/**
 * Confere se o Claude dentro do sandbox está autenticado *e ainda vale*.
 * Existir o arquivo não basta: a cópia congelada pelo `--share-credentials`
 * vence sozinha e o refresh dela é rotacionado pelo host (ver credentials.mjs).
 */
export async function checkAuth(name) {
  const res = await execCapture(name, ["bash", "-lc", "cat ~/.claude/.credentials.json 2>/dev/null"]);
  const hostFile = path.join(userClaudeDir(), ".credentials.json");
  const host = existsSync(hostFile) ? parseCredentials(readFileSync(hostFile, "utf8")) : null;
  return credentialVerdict({ sandbox: parseCredentials(res.stdout), host });
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
function warnIfIndexMcpFailed(state, detected) {
  const message = describeMcpFailure(detected, state.mcpServers);
  if (!message) return;
  process.stdout.write(paint(C.yellow, `\n  ! ${message}\n`));
}

/**
 * A sessão morreu por credencial e não por trabalho. Sem este aviso, a
 * iteração custa 1 segundo e o usuário vê só "iteração falhou" apontando
 * para um JSONL de 5 KB — o comando que conserta fica escondido lá dentro.
 */
async function warnIfAuthFailed(state, cfg) {
  if (!isAuthFailure(state)) return;
  // Relê a credencial em vez de chutar o comando: refresh morto só sai com
  // `ralph login`, e mandar `--share-credentials` ali faz o usuário recopiar
  // um token que já nasce recusado.
  const advice = authFailureAdvice(await checkAuth(cfg.sandboxName));
  process.stdout.write(
    paint(C.red, `\n  ! o claude do sandbox '${cfg.sandboxName}' não conseguiu autenticar.\n`) +
      paint(C.dim, `    ${advice.replace(/\n\s*/g, "\n    ")}\n`)
  );
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
export async function runIteration(root, cfg, { iteration = 1, total = 1, prompt, extraArgs = [], provider }) {
  const workdir = inContainer(root);
  const jsonl = logFile(root, iteration);
  const renderer = createStreamRenderer({
    onEvent: (evt) => appendFileSync(jsonl, JSON.stringify(evt) + "\n", "utf8"),
  });

  const header = `iteração ${iteration}/${total}${provider.kind === "local" ? ` · Provedor local (${provider.model})` : ""}`;
  process.stdout.write(
    `\n${paint(C.magenta, "━".repeat(8))} ${paint(C.bold, header)} ${paint(C.dim, new Date().toLocaleTimeString())} ${paint(C.magenta, "━".repeat(8))}\n`
  );

  // MCP efêmero (issue #7, ADR-0002): `--strict-mcp-config` sempre — o
  // `.mcp.json` do repositório alvo é curado pra sessão de host e nunca deve
  // ser lido dentro do sandbox, com ou sem índice detectado. `--mcp-config`
  // só entra quando há backend que sobe servidor (hoje só code-review-graph);
  // sem ele, `--strict-mcp-config` sozinho já deixa a sessão sem MCP nenhum.
  const detected = detectKnowledgeIndex(root, cfg);
  const probeResult = needsOllamaProbe(detected) ? await probeKnowledgeIndex(cfg.sandboxName) : null;
  const { mcpConfig, tools } = renderKnowledgeIndex(detected, probeResult, {
    containerRoot: workdir,
    embeddingEnv: resolveEmbeddingEnv(readTargetMcpConfig(root), cfg.crgEmbeddingEnv),
  });
  const mcpArgs = mcpConfig ? ["--mcp-config", JSON.stringify(mcpConfig), "--strict-mcp-config"] : ["--strict-mcp-config"];

  // `--agents` por último: o prompt da iteração depende do subagente
  // "orientation" existir (passo 1 delega nele), então a nossa definição
  // precisa vencer se quem chamou `ralph` também passar `--agents` cru via
  // `-- --agents ...` — a última ocorrência de uma flag não-variádica é a
  // que o CLI do claude usa.
  //
  // Refeito a cada iteração (não junto de `prompt`, que `runLoop` monta uma
  // vez só): o índice de conhecimento do repo alvo pode aparecer entre
  // iterações (ex.: outra ferramenta rodando em paralelo o gera), e o custo
  // de refazer é um `readFileSync` e um `readdirSync` — não vale cachear.
  // Orientação herda o modelo do Provedor resolvido, não `cfg.orientationModel`
  // puro: no Provedor local os dois campos moram em `cfg.nightProvider`
  // (ADR-0007, "um Provedor por processo, dois modelos possíveis dentro
  // dele"). Sem `--night`, `provider.orientationModel` é `cfg.orientationModel`
  // sem mudança nenhuma.
  const agents = buildOrientationAgent(buildOrientationPrompt(root, cfg), { ...cfg, orientationModel: provider.orientationModel }, tools);
  const { code, stderr } = await runClaudeStreaming(cfg.sandboxName, {
    workdir,
    prompt,
    model: provider.model,
    env: renderProviderEnv(provider),
    extraArgs: [...extraArgs, ...mcpArgs, "--agents", JSON.stringify(agents)],
    onChunk: (chunk) => renderer.write(chunk),
  });
  const state = renderer.end();

  warnIfSkillMissing(state, cfg);
  warnIfIndexMcpFailed(state, detected);
  await warnIfAuthFailed(state, cfg);

  if (code !== 0 && !state.finalResult) {
    process.stderr.write(paint(C.red, `\n  claude saiu com código ${code}\n`));
    if (stderr.trim()) process.stderr.write(paint(C.dim, stderr.trim().split("\n").slice(-8).join("\n") + "\n"));
  }

  return {
    code,
    state,
    logPath: jsonl,
    complete: foundPromise(state, cfg.completionPromise),
    blocked: foundPromise(state, cfg.blockedPromise),
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

  // Sem fallback pro Claude pago, não há por que exigir a credencial dele
  // (ADR-0007) — `ralph afk --night` roda num sandbox que nunca viu `/login`.
  const provider = resolveProvider(cfg, { night: !!cfg.night });
  if (requiresAnthropicAuth(provider)) {
    const auth = await checkAuth(cfg.sandboxName);
    if (!auth.ok) throw new Error(`sandbox '${cfg.sandboxName}': ${auth.message}`);
  } else {
    // As três provas do Provedor (issue #32): falha alta antes da iteração 1,
    // nunca um fallback silencioso pro Claude pago — o operador está dormindo
    // e não veria o aviso a tempo.
    const probeResult = await probeProviderBoth(cfg.sandboxName, provider);
    const failure = describeProviderDegradation(probeResult);
    if (failure) throw new Error(failure);
  }
  return { branch, provider };
}

/** Loop AFK: N iterações de contexto novo até a promise ou o teto. */
export async function runLoop(root, cfg, { iterations, allowBranch = false, extraArgs = [] }) {
  const { branch, provider } = await prepare(root, cfg, { allowBranch });
  const prompt = buildPrompt(root, cfg);

  // `modelo ${provider.model}` sai idêntico a `modelo ${cfg.model}` de antes
  // desta issue quando o Provedor é anthropic — só o sufixo é novo, e só
  // aparece com `--night`.
  const providerSuffix = provider.kind === "local" ? " · Provedor local" : "";
  process.stdout.write(
    `\n${paint(C.bold, "Ralph")} ${paint(C.dim, `· ${path.basename(root)} · branch ${branch ?? "—"} · modelo ${provider.model}${providerSuffix} · até ${iterations} iterações`)}\n`
  );

  // Provedor local não reporta `total_cost_usd` — "sem custo" e "custo não
  // reportado" significam coisas opostas para quem lê o resumo depois
  // (ADR-0008), então o fallback muda com o Provedor, não só o texto do
  // cabeçalho.
  const costFallback = provider.kind === "local" ? `sem custo — Provedor local (${provider.model})` : "custo não reportado";

  const started = Date.now();
  let cost = 0;
  let modelTotals = {};
  let subagentTokens = 0;
  for (let i = 1; i <= iterations; i++) {
    const result = await runIteration(root, cfg, { iteration: i, total: iterations, prompt, extraArgs, provider });
    cost += result.state.costUsd ?? 0;
    modelTotals = accumulateModelUsage(modelTotals, result.state.modelUsage);
    subagentTokens += result.state.subagentTokens ?? 0;

    if (result.complete) {
      process.stdout.write(paint(C.green, `\n✓ backlog concluído na iteração ${i}.\n`));
      return summary(i, cost, modelTotals, subagentTokens, started, "complete", costFallback);
    }
    if (result.blocked) {
      process.stdout.write(paint(C.yellow, `\n■ Ralph travou na iteração ${i} e pediu um humano.\n`));
      return summary(i, cost, modelTotals, subagentTokens, started, "blocked", costFallback);
    }
    if (result.code !== 0) {
      process.stdout.write(paint(C.red, `\n✗ iteração ${i} falhou. Log: ${path.relative(root, result.logPath)}\n`));
      return summary(i, cost, modelTotals, subagentTokens, started, "error", costFallback);
    }
    if (cfg.cooldownSeconds > 0 && i < iterations) {
      await new Promise((r) => setTimeout(r, cfg.cooldownSeconds * 1000));
    }
  }
  process.stdout.write(paint(C.yellow, `\n⏱ teto de ${iterations} iterações atingido sem a promise.\n`));
  return summary(iterations, cost, modelTotals, subagentTokens, started, "max-iterations", costFallback);
}

/**
 * `subagentTokens` só aparece na linha quando > 0 — repositório sem
 * subagente nenhum (a maioria dos logs, hoje) mantém o relatório idêntico
 * ao de antes da issue #9. `costFallback` (issue #31) é "custo não
 * reportado" por padrão — o texto de sempre para quem não passa `--night`.
 */
function summary(iterations, cost, modelTotals, subagentTokens, started, status, costFallback = "custo não reportado") {
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  const subagent = subagentTokens ? ` · subagentes ${subagentTokens} tokens` : "";
  process.stdout.write(
    paint(C.dim, `  ${iterations} iterações · ${mins} min · ${formatCostByModel(cost, modelTotals, costFallback)}${subagent}\n`)
  );
  return { status, iterations, cost };
}

