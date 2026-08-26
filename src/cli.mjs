#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoRoot, ralphHome, sandboxNameFor, userPluginsDir, userClaudeDir, toContainerPath } from "./paths.mjs";
import { DEFAULTS, loadConfig, saveConfig, isInitialized, ralphDir, withOverrides } from "./config.mjs";
import {
  dockerAvailable,
  listSandboxes,
  sandboxExists,
  removeSandbox,
  execCapture,
  execInteractive,
  runAgentInteractive,
  ensureSandbox,
  mountsFor,
} from "./sandbox.mjs";
import { runLoop, runIteration, prepare, buildPrompt, currentBranch, ensureBootstrap, ensureSetup, checkAuth } from "./runner.mjs";
import { paint, colors as C } from "./stream.mjs";
import {
  detect as detectKnowledgeIndex,
  describe as describeKnowledgeIndex,
  describeAvailability as describeKnowledgeIndexAvailability,
  describeDegradation as describeKnowledgeIndexDegradation,
  describeInstallFailure as describeKnowledgeIndexInstallFailure,
  needsEmbeddingProbe,
  probe as probeKnowledgeIndex,
  probeInstall as probeKnowledgeIndexInstall,
  readTargetMcpConfig,
  resolveEmbeddingEnv,
  withInstallBlock,
} from "./knowledge-index.mjs";
import { checkOrientationContract, readOrientationTemplate } from "./orientation.mjs";
import {
  resolve as resolveProvider,
  describeAvailability as describeProviderAvailability,
  describeDegradation as describeProviderDegradation,
  probeBoth as probeProviderBoth,
} from "./provider.mjs";

const root = repoRoot();

// --------------------------------------------------------------- argumentos --
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      flags._passthrough = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a === "-n") {
      flags.iterations = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const die = (msg) => {
  process.stderr.write(paint(C.red, `✗ ${msg}\n`));
  process.exit(1);
};

// --------------------------------------------------------------------- init --
function detectFeedbackLoops(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  const run = existsSync(path.join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(dir, "yarn.lock"))
      ? "yarn"
      : existsSync(path.join(dir, "bun.lockb"))
        ? "bun"
        : "npm run";
  const want = ["typecheck", "type-check", "tsc", "test", "lint", "check", "build"];
  const seen = new Set();
  const loops = [];
  for (const name of want) {
    if (!scripts[name]) continue;
    const kind = /type|tsc/.test(name) ? "types" : name;
    if (seen.has(kind)) continue;
    seen.add(kind);
    loops.push(`${run} ${name}`.replace("npm run run", "npm run"));
  }
  return loops;
}

function cmdInit(flags) {
  const dir = ralphDir(root);
  mkdirSync(path.join(dir, "logs"), { recursive: true });

  const cfg = isInitialized(root) && !flags.force ? loadConfig(root) : { ...DEFAULTS };
  cfg.sandboxName ||= sandboxNameFor(root);
  cfg.feedbackLoops ??= detectFeedbackLoops(root);
  saveConfig(root, cfg);

  const promptSrc = path.join(ralphHome(), "prompts", `${flags.prompt ?? "implement"}.md`);
  if (!existsSync(promptSrc)) die(`prompt '${flags.prompt}' não existe em ${path.join(ralphHome(), "prompts")}`);
  const promptDst = path.join(root, cfg.promptFile);
  if (!existsSync(promptDst) || flags.force) {
    mkdirSync(path.dirname(promptDst), { recursive: true });
    copyFileSync(promptSrc, promptDst);
  }

  const progress = path.join(root, cfg.progressFile);
  if (!existsSync(progress)) {
    mkdirSync(path.dirname(progress), { recursive: true });
    copyFileSync(path.join(ralphHome(), "templates", "PROGRESS.md"), progress);
  }

  const setup = path.join(root, cfg.setupScript ?? ".ralph/setup.sh");
  if (!existsSync(setup)) {
    mkdirSync(path.dirname(setup), { recursive: true });
    copyFileSync(path.join(ralphHome(), "templates", "setup.sh"), setup);
  }

  // Roda em todo `init`, não só quando `setup.sh` acaba de nascer do template:
  // o índice pode ter sido construído depois do primeiro `ralph init`. Pura e
  // idempotente (ver `withInstallBlock`) — repositório sem backend que precise
  // de binário no sandbox não grava nada de novo (ADR-0001).
  const setupBefore = readFileSync(setup, "utf8");
  const setupAfter = withInstallBlock(setupBefore, detectKnowledgeIndex(root, cfg));
  const setupChanged = setupAfter !== setupBefore;
  if (setupChanged) writeFileSync(setup, setupAfter, "utf8");

  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "logs/\n", "utf8");

  process.stdout.write(`${paint(C.green, "✓")} .ralph/ criado em ${root}\n\n`);
  process.stdout.write(`  prompt        ${cfg.promptFile}\n`);
  process.stdout.write(`  progresso     ${cfg.progressFile}\n`);
  process.stdout.write(
    `  setup         ${cfg.setupScript ?? ".ralph/setup.sh"}${setupChanged ? paint(C.dim, " (instalação do índice de conhecimento adicionada)") : ""}\n`
  );
  process.stdout.write(`  sandbox       ${cfg.sandboxName}\n`);
  process.stdout.write(`  modelo        ${cfg.model}\n`);
  process.stdout.write(
    `  feedback      ${cfg.feedbackLoops.length ? cfg.feedbackLoops.join(", ") : paint(C.yellow, "nenhum detectado — preencha feedbackLoops no config")}\n\n`
  );

  if (!existsSync(path.join(root, "docs", "agents", "issue-tracker.md"))) {
    process.stdout.write(
      paint(C.yellow, "! docs/agents/issue-tracker.md não existe.\n") +
        "  Ralph não sabe de onde puxar tarefas. Neste repo, rode no Claude Code:\n" +
        "    /mattpocock-skills:setup-matt-pocock-skills\n" +
        "  e depois /mattpocock-skills:to-tickets para gerar o backlog.\n\n"
    );
  }
  process.stdout.write(`Próximo passo: ${paint(C.bold, "ralph doctor")}\n`);
}

// ------------------------------------------------------------------- doctor --
async function cmdDoctor(flags) {
  const cfg = loadConfig(root);
  const ok = (m) => process.stdout.write(`${paint(C.green, "✓")} ${m}\n`);
  const warn = (m) => process.stdout.write(`${paint(C.yellow, "!")} ${m}\n`);
  const bad = (m) => process.stdout.write(`${paint(C.red, "✗")} ${m}\n`);

  process.stdout.write(`\n${paint(C.bold, "Ralph doctor")} ${paint(C.dim, root)}\n\n`);

  isInitialized(root) ? ok(".ralph/config.json presente") : bad(".ralph ausente — rode 'ralph init'");

  const branch = currentBranch(root);
  if (!branch) warn("não é um repositório git — Ralph commita a cada iteração, considere 'git init'");
  else if ((cfg.protectedBranches ?? []).includes(branch)) warn(`branch atual é '${branch}' — crie uma branch de trabalho`);
  else ok(`branch '${branch}'`);

  existsSync(path.join(root, "docs", "agents", "issue-tracker.md"))
    ? ok("docs/agents/issue-tracker.md (fonte de tarefas configurada)")
    : bad("docs/agents/issue-tracker.md ausente — rode /mattpocock-skills:setup-matt-pocock-skills");

  const plugins = userPluginsDir();
  plugins ? ok(`plugins do host em ${plugins}`) : warn("nenhum ~/.claude/plugins — as skills não entrarão no sandbox");

  cfg.feedbackLoops?.length
    ? ok(`feedback loops: ${cfg.feedbackLoops.join(", ")}`)
    : warn("nenhum feedback loop configurado — Ralph vai commitar às cegas");

  // Sem índice, nenhuma linha entra aqui — é essa ausência que garante que um
  // repositório sem índice de conhecimento produz a mesma saída de sempre.
  const detectedIndexes = detectKnowledgeIndex(root, cfg);
  for (const line of describeKnowledgeIndex(detectedIndexes)) ok(line);

  // Só cobra o contrato de quem de fato delega (checkOrientationContract
  // devolve applicable: false pro resto) — um prompt.md antigo ou custom que
  // orienta inline não é bug (issue #17).
  const promptPath = path.join(root, cfg.promptFile);
  if (existsSync(promptPath)) {
    const contract = checkOrientationContract(readFileSync(promptPath, "utf8"), readOrientationTemplate());
    if (contract.applicable) {
      contract.ok
        ? ok("contrato do Resumo de orientação em dia")
        : warn(
            `contrato do Resumo de orientação divergiu (${cfg.promptFile} está desatualizado em relação ao template instalado) — rode 'ralph init --force' para re-sincronizar. ${contract.issues.join("; ")}`
          );
    }
  }

  if (!(await dockerAvailable())) return bad("docker sandbox indisponível — Docker Desktop está rodando?");
  ok("docker sandbox disponível");

  if (!(await sandboxExists(cfg.sandboxName))) {
    warn(`sandbox '${cfg.sandboxName}' ainda não existe (será criado na primeira execução)`);
    process.stdout.write(`\n  Depois: ${paint(C.bold, "ralph login")} para autenticar dentro dele.\n`);
    return;
  }
  ok(`sandbox '${cfg.sandboxName}' existe`);

  // A sonda de embeddings só faz sentido com sandbox de pé — sem isso não há
  // onde rodar o pedido real. Repositório sem code-review-graph nunca chega aqui.
  if (needsEmbeddingProbe(detectedIndexes)) {
    const embeddingEnv = resolveEmbeddingEnv(readTargetMcpConfig(root), cfg.crgEmbeddingEnv);
    const probed = await probeKnowledgeIndex(cfg.sandboxName, embeddingEnv);
    const degradation = describeKnowledgeIndexDegradation(detectedIndexes, probed);
    degradation ? warn(degradation) : ok(describeKnowledgeIndexAvailability(detectedIndexes));
  }

  // Night mode (issue #33/#40): o gate é a flag explícita `--night`, não a
  // presença de `nightProvider` no config — desde a issue #40 o padrão mora
  // em DEFAULTS, então "configurou" e "quer as provas agora" deixaram de ser
  // a mesma coisa. Sem a flag: nenhuma linha nova, nenhuma chamada de rede.
  if (flags.night) {
    const provider = resolveProvider(cfg, { night: true });
    const probeResult = await probeProviderBoth(cfg.sandboxName, provider);
    const degradation = describeProviderDegradation(probeResult, provider.minContext);
    degradation ? warn(degradation) : ok(describeProviderAvailability(provider));
  }

  // Só o code-review-graph precisa de binário no sandbox, mesma guarda de
  // `needsEmbeddingProbe` só que aplicada dentro de `probeInstall` (issue #12) —
  // é a checagem que dá ao aviso de MCP-falho da iteração algo de verdade
  // para diagnosticar.
  const installProbe = await probeKnowledgeIndexInstall(cfg.sandboxName, detectedIndexes);
  if (installProbe) {
    const installFailure = describeKnowledgeIndexInstallFailure(installProbe);
    installFailure ? warn(installFailure) : ok("binário do code-review-graph instalado no sandbox");
  }

  const stamped = await execCapture(cfg.sandboxName, ["test", "-f", "/home/agent/.claude/.ralph-bootstrap"]);
  stamped.code === 0 ? ok("bootstrap aplicado") : warn("bootstrap ainda não rodou");

  // Fonte da verdade: o que o próprio claude enxerga, não o que está no disco.
  // Já aconteceu de os arquivos estarem todos lá e o plugin ser ignorado porque
  // known_marketplaces.json ainda apontava para um caminho do Windows.
  const listed = await execCapture(cfg.sandboxName, ["bash", "-lc", "claude plugin list 2>&1"]);
  const enabledPlugins = listed.stdout
    .split("\n")
    .map((l) => l.replace(/^[\s\u276f>*]+/, "").trim())
    .filter((l) => /^\S+@\S+$/.test(l));
  if (enabledPlugins.length) ok(`plugins vistos pelo claude: ${enabledPlugins.join(", ")}`);
  else bad("o claude do sandbox não enxerga nenhum plugin — rode 'ralph bootstrap --force'");

  for (const required of cfg.requireSkills ?? ["mattpocock-skills:implement"]) {
    const pluginName = required.split(":")[0];
    enabledPlugins.some((p) => p.startsWith(pluginName + "@"))
      ? ok(`/${required} disponível`)
      : bad(`/${required} indisponível — o plugin '${pluginName}' não carregou no sandbox`);
  }

  const auth = await checkAuth(cfg.sandboxName);
  auth.ok ? ok(auth.message) : bad(auth.message);

  // Só cobra o gh se o tracker deste repo realmente depende dele.
  const trackerPath = path.join(root, "docs", "agents", "issue-tracker.md");
  const tracker = existsSync(trackerPath) ? readFileSync(trackerPath, "utf8") : "";
  if (/\bgh\s|github/i.test(tracker)) {
    const gh = await execCapture(cfg.sandboxName, ["bash", "-lc", "gh auth status 2>&1 | head -3"]);
    gh.stdout.includes("Logged in")
      ? ok("gh autenticado no sandbox")
      : bad("gh NÃO autenticado no sandbox — rode 'ralph gh-login' (o tracker deste repo usa GitHub)");
  }
  process.stdout.write("\n");
}

// -------------------------------------------------------------------- login --
async function cmdLogin(flags) {
  const cfg = loadConfig(root);
  await ensureSandbox(cfg.sandboxName, root, cfg);
  await ensureBootstrap(cfg.sandboxName, root);

  if (flags["share-credentials"]) {
    const src = path.join(userClaudeDir(), ".credentials.json");
    if (!existsSync(src)) die(`credenciais do host não encontradas em ${src}`);
    process.stdout.write(
      paint(C.yellow, "! copiando o token do host para dentro do sandbox.\n") +
        "  O agente passa a poder ler seu token de sessão. Só faça isso em sandbox de confiança.\n"
    );
    const res = await execCapture(
      cfg.sandboxName,
      ["bash", "-lc", "mkdir -p ~/.claude && cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json && echo ok"],
      { stdin: readFileSync(src, "utf8") }
    );
    if (res.code !== 0 || !res.stdout.includes("ok")) die(`falha ao copiar credenciais: ${res.stderr.trim()}`);
    process.stdout.write(`${paint(C.green, "✓")} credenciais copiadas para o sandbox\n`);
    return;
  }

  process.stdout.write(
    `Abrindo o Claude dentro do sandbox '${cfg.sandboxName}'.\n` +
      `Rode ${paint(C.bold, "/login")} lá dentro e depois saia com ${paint(C.bold, "/exit")}.\n` +
      paint(C.dim, "(alternativa não-interativa: ralph login --share-credentials)\n\n")
  );
  const code = await runAgentInteractive(cfg.sandboxName);
  process.exit(code);
}


// ----------------------------------------------------------------- gh-login --
/**
 * Autentica o `gh` dentro do sandbox. Sem isso, um repo cujo issue-tracker vive
 * no GitHub bloqueia na primeira iteração: o agente não consegue listar a
 * frontier nem fechar ticket.
 */
async function cmdGhLogin(flags) {
  const cfg = loadConfig(root);
  await ensureSandbox(cfg.sandboxName, root, cfg);
  await ensureBootstrap(cfg.sandboxName, root);

  const has = await execCapture(cfg.sandboxName, ["bash", "-lc", "command -v gh >/dev/null && echo yes || echo no"]);
  if (!has.stdout.includes("yes")) die("o sandbox não tem o gh instalado");

  if (flags.token) {
    let token = typeof flags.token === "string" ? flags.token : "";
    if (!token) {
      const local = await import("node:child_process");
      try {
        token = local.execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        die("não consegui obter um token do gh do host — rode 'gh auth login' aqui fora ou passe --token=<valor>");
      }
    }
    process.stdout.write(
      paint(C.yellow, "! injetando um token do GitHub no sandbox.\n") +
        "  O agente passa a agir no GitHub com as permissões desse token. Prefira um\n" +
        "  token de escopo mínimo (repo + issues no repositório alvo).\n"
    );
    const res = await execCapture(cfg.sandboxName, ["bash", "-lc", "gh auth login --with-token && gh auth status 2>&1 | head -3"], {
      stdin: token.endsWith("\n") ? token : token + "\n",
    });
    process.stdout.write(res.stdout.replace(/^/gm, "  "));
    if (res.code !== 0) die(`gh auth login falhou: ${res.stderr.trim().split("\n").slice(-2).join(" ")}`);
    process.stdout.write(`${paint(C.green, "✓")} gh autenticado no sandbox\n`);
    return;
  }

  process.stdout.write(
    `Abrindo ${paint(C.bold, "gh auth login")} dentro do sandbox '${cfg.sandboxName}'.\n` +
      paint(C.dim, "(alternativa não-interativa: ralph gh-login --token)\n\n")
  );
  const code = await execInteractive(cfg.sandboxName, ["gh", "auth", "login"], { workdir: toContainerPath(root) });
  process.exit(code);
}

// ---------------------------------------------------------------- once / afk --
async function cmdOnce(flags) {
  const cfg = withOverrides(loadConfig(root), flags);
  const { provider } = await prepare(root, cfg, { allowBranch: !!flags["allow-branch"] });
  const prompt = buildPrompt(root, cfg);
  const res = await runIteration(root, cfg, { iteration: 1, total: 1, prompt, extraArgs: flags._passthrough ?? [], provider });
  if (res.complete) process.stdout.write(paint(C.green, "\n✓ backlog concluído.\n"));
  else if (res.blocked) process.stdout.write(paint(C.yellow, "\n■ Ralph pediu um humano.\n"));
  process.exit(res.code === 0 ? 0 : 1);
}

async function cmdAfk(flags) {
  const cfg = withOverrides(loadConfig(root), flags);
  const iterations = Number(flags.iterations ?? cfg.maxIterations);
  if (!Number.isInteger(iterations) || iterations < 1) die("-n precisa ser um inteiro >= 1");
  const res = await runLoop(root, cfg, {
    iterations,
    allowBranch: !!flags["allow-branch"],
    extraArgs: flags._passthrough ?? [],
  });
  process.exit(res.status === "error" ? 1 : 0);
}

// ------------------------------------------------------------------- status --
function cmdStatus() {
  const cfg = loadConfig(root);
  const progress = path.join(root, cfg.progressFile);
  process.stdout.write(`\n${paint(C.bold, path.basename(root))} ${paint(C.dim, `· branch ${currentBranch(root) ?? "—"} · sandbox ${cfg.sandboxName}`)}\n\n`);

  if (!existsSync(progress)) {
    process.stdout.write(paint(C.dim, "  sem PROGRESS.md ainda\n"));
  } else {
    const entries = readFileSync(progress, "utf8").split(/^## /m).slice(1);
    const last = entries.slice(-3);
    process.stdout.write(paint(C.dim, `  ${entries.length} entradas · últimas ${last.length}:\n\n`));
    for (const e of last) process.stdout.write("  ## " + e.trim().replace(/\n/g, "\n  ") + "\n\n");
  }

  const logs = path.join(ralphDir(root), "logs");
  if (existsSync(logs)) {
    const files = readdirSync(logs).filter((f) => f.endsWith(".jsonl")).sort();
    if (files.length) process.stdout.write(paint(C.dim, `  ${files.length} logs · mais recente: .ralph/logs/${files.at(-1)}\n\n`));
  }
}

// ------------------------------------------------------------ shell / rm / bs --
async function cmdShell() {
  const cfg = loadConfig(root);
  await ensureSandbox(cfg.sandboxName, root, cfg);
  const code = await execInteractive(cfg.sandboxName, ["bash", "-l"], { workdir: toContainerPath(root) });
  process.exit(code);
}

async function cmdBootstrap(flags) {
  const cfg = loadConfig(root);
  await ensureSandbox(cfg.sandboxName, root, cfg);
  await ensureBootstrap(cfg.sandboxName, root, { force: !!flags.force });
  await ensureSetup(cfg.sandboxName, root, cfg, { force: !!flags.force });
  process.stdout.write(`${paint(C.green, "✓")} sandbox preparado\n`);
}

async function cmdRm() {
  const cfg = loadConfig(root);
  if (!(await sandboxExists(cfg.sandboxName))) return process.stdout.write("nada a remover\n");
  await removeSandbox(cfg.sandboxName);
  process.stdout.write(`${paint(C.green, "✓")} sandbox '${cfg.sandboxName}' removido\n`);
}

async function cmdSandboxes() {
  for (const s of await listSandboxes()) {
    process.stdout.write(`${s.name.padEnd(34)} ${s.status.padEnd(10)} ${paint(C.dim, s.workspace)}\n`);
  }
}

function cmdMounts() {
  const cfg = loadConfig(root);
  for (const m of mountsFor(root, cfg)) process.stdout.write(`${m}\n    -> ${toContainerPath(m.replace(/:ro$/, ""))}\n`);
}

// --------------------------------------------------------------------- help --
function cmdHelp() {
  process.stdout.write(`
${paint(C.bold, "ralph")} — loop Ralph Wiggum para Claude Code, um contexto novo por iteração.

${paint(C.bold, "Comandos")}
  init [--prompt <nome>] [--force]   cria .ralph/ neste repo
  doctor [--night]                   checa docker, sandbox, login, plugins, tarefas
  login [--share-credentials]        autentica o Claude dentro do sandbox
  gh-login [--token[=valor]]         autentica o gh dentro do sandbox
  once [--allow-branch]              UMA iteração, você assistindo (HITL)
  afk [-n N] [--allow-branch]        loop até a promise ou o teto (AFK)
  status                             últimas entradas do PROGRESS.md
  shell                              bash dentro do sandbox
  bootstrap [--force]                reinstala plugins/skills no sandbox
  sandboxes                          lista os sandboxes da máquina
  mounts                             mostra o que é montado e onde
  rm                                 remove o sandbox deste repo

${paint(C.bold, "Opções comuns")}
  --model <nome>     sobrepõe o modelo da iteração (padrão: ${DEFAULTS.model}; com --night, a tag do nightProvider)
  --prompt <arquivo> usa outro prompt de loop
  --night            roda contra o Provedor local (nightProvider no config) em vez da API paga
  -- <args>          repassa argumentos crus ao claude

${paint(C.bold, "Fluxo típico")}
  cd meu-repo
  ralph init && ralph doctor && ralph login
  git switch -c ralph/checkout
  ralph once          ${paint(C.dim, "# aprenda com uma iteração")}
  ralph afk -n 20     ${paint(C.dim, "# solte o loop")}
`);
}

// --------------------------------------------------------------------- main --
const [, , command = "help", ...rest] = process.argv;
const { flags } = parseArgs(rest);

const commands = {
  init: () => cmdInit(flags),
  doctor: () => cmdDoctor(flags),
  login: () => cmdLogin(flags),
  "gh-login": () => cmdGhLogin(flags),
  once: () => cmdOnce(flags),
  afk: () => cmdAfk(flags),
  loop: () => cmdAfk(flags),
  status: cmdStatus,
  shell: cmdShell,
  bootstrap: () => cmdBootstrap(flags),
  sandboxes: cmdSandboxes,
  mounts: cmdMounts,
  rm: cmdRm,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};

const handler = commands[command];
if (!handler) die(`comando desconhecido: ${command} (tente 'ralph help')`);

try {
  await handler();
} catch (err) {
  die(err.message);
}
