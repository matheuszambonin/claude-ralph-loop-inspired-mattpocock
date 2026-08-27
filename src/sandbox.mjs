import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { toContainerPath, toMountArg, userPluginsDir, ralphHome } from "./paths.mjs";

const execFileAsync = promisify(execFile);

export class SandboxError extends Error {}

async function docker(args, opts = {}) {
  try {
    return await execFileAsync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch (err) {
    throw new SandboxError(
      `docker ${args.slice(0, 3).join(" ")} falhou: ${(err.stderr || err.message || "").trim().split("\n").slice(-3).join(" ")}`
    );
  }
}

export async function dockerAvailable() {
  try {
    await execFileAsync("docker", ["sandbox", "version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** Lista sandboxes conhecidos: [{ name, agent, status, workspace }]. */
export async function listSandboxes() {
  const { stdout } = await docker(["sandbox", "ls"]);
  const lines = stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const header = lines.findIndex((l) => /^SANDBOX\s/.test(l));
  if (header === -1) return [];
  return lines.slice(header + 1).map((line) => {
    const [name, agent, status, ...rest] = line.split(/\s{2,}/);
    return { name, agent, status, workspace: rest.join("  ") };
  }).filter((s) => s.name);
}

export async function sandboxExists(name) {
  return (await listSandboxes()).some((s) => s.name === name);
}

/**
 * Monta a lista de workspaces do sandbox. O primeiro é o repo (rw); os demais
 * entram read-only, e são o que faz as skills do Matt Pocock existirem lá
 * dentro — sem isso o sandbox é um Claude Code pelado.
 */
export function mountsFor(root, cfg) {
  // O primeiro workspace vence: rodar o Ralph sobre o próprio Ralph faria o
  // repo entrar como rw e a raiz de instalação como :ro, e o docker recusa o
  // mesmo workspace com permissões opostas ("conflicting read-only settings").
  const seen = new Set();
  const mounts = [];
  const add = (hostPath, readOnly = false) => {
    const key = path.resolve(hostPath);
    const id = process.platform === "win32" ? key.toLowerCase() : key;
    if (seen.has(id)) return;
    seen.add(id);
    mounts.push(toMountArg(hostPath, readOnly));
  };

  add(root);
  const plugins = userPluginsDir();
  if (plugins) add(plugins, true);
  add(ralphHome(), true);
  for (const extra of cfg.extraMounts ?? []) {
    const ro = extra.endsWith(":ro");
    add(ro ? extra.slice(0, -3) : extra, ro);
  }
  return mounts;
}

/**
 * Assinatura estável de "o compartilhamento de arquivos do docker sandbox não
 * conseguiu ser construído" (issue #24/#26): tipo de recurso + errno. A frase
 * de panic inteira em volta (`panic detected in openvmm: failed to resolve
 * resource of type…`) não é contrato de API e muda entre versões do openvmm —
 * só `virtio:virtiofs` + `EINVAL` são estáveis.
 */
function hasVirtiofsEinvalSignature(stderr) {
  return typeof stderr === "string" && /virtio:virtiofs/.test(stderr) && /\bEINVAL\b/.test(stderr);
}

/**
 * Traduz a falha de `docker sandbox create` para o usuário. Só é chamada
 * depois que o `create` já falhou, então sempre devolve algo. Se o stderr
 * casar com a assinatura de virtiofs, o diagnóstico completo entra no lugar
 * do código de saída cru — mesma forma de `describeMcpFailure` em
 * `knowledge-index.mjs`: função pura, recebe dados, devolve texto.
 */
export function describeSandboxCreateFailure({ code, stderr, mounts }) {
  if (!hasVirtiofsEinvalSignature(stderr)) {
    return `docker sandbox create falhou (código ${code})`;
  }
  const workspaces = (mounts ?? []).map((m) => `  - ${m}`).join("\n");
  return (
    "docker sandbox create falhou ao construir o compartilhamento de arquivos do sandbox.\n" +
    "A limitação é do docker sandbox — virtiofs é a única primitiva de compartilhamento de arquivos que ele tem, " +
    "um device por workspace montado antes do boot — e não do Ralph. Não há flag, variável de ambiente nem " +
    "setting do Docker Desktop que contorne isso.\n" +
    "Workspaces deste sandbox:\n" +
    `${workspaces}\n` +
    "Saída: trabalhe num clone do repositório alvo em disco local."
  );
}

/**
 * Cria o sandbox se ele ainda não existir. Devolve true se criou agora.
 *
 * Na primeira vez o docker baixa a imagem do template (centenas de MB) e todo
 * o progresso do download sai pelo stderr dele — capturar sem repassar faria
 * o comando parecer travado por vários minutos. stdout segue herdado
 * (`inherit`), sem uso aqui; o stderr é repassado à tela em tempo real
 * (`process.stderr.write`) e acumulado ao mesmo tempo, para
 * `describeSandboxCreateFailure` ter o texto para traduzir se o `create`
 * falhar. Não troque de volta para `stdio: inherit` puro no stderr: isso
 * apaga o diagnóstico de falha.
 */
export async function ensureSandbox(name, root, cfg) {
  if (await sandboxExists(name)) return false;
  process.stdout.write(`criando o sandbox '${name}'… na primeira vez isso baixa a imagem do template e pode levar alguns minutos.\n`);
  const mounts = mountsFor(root, cfg);
  const args = ["sandbox", "create", "--name", name, "claude", ...mounts];
  const { code, stderr } = await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c ?? 1, stderr }));
  });
  if (code !== 0) throw new SandboxError(describeSandboxCreateFailure({ code, stderr, mounts }));
  return true;
}

export async function removeSandbox(name) {
  await docker(["sandbox", "rm", name]);
}

/** Executa um comando dentro do sandbox e devolve stdout/stderr capturados. */
export async function execCapture(name, argv, { workdir, stdin } = {}) {
  const args = ["sandbox", "exec"];
  if (workdir) args.push("-w", workdir);
  if (stdin !== undefined) args.push("-i");
  args.push(name, ...argv);

  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

/** Executa um comando dentro do sandbox herdando o terminal (interativo). */
export function execInteractive(name, argv, { workdir } = {}) {
  const args = ["sandbox", "exec", "-it"];
  if (workdir) args.push("-w", workdir);
  args.push(name, ...argv);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Sessão interativa do agente (é aqui que se roda `/login` na primeira vez). */
export function runAgentInteractive(name, agentArgs = []) {
  const args = ["sandbox", "run", name];
  if (agentArgs.length) args.push("--", ...agentArgs);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Executa `claude -p` dentro do sandbox emitindo stream-json, entregando cada
 * pedaço bruto ao renderizador. É o `docker sandbox run … --output-format
 * stream-json | jq` dos artigos, sem o jq.
 *
 * `env` (night mode, issue #31) prefixa o comando com `env K=V …`, mesmo
 * padrão que `ensureBootstrap` já usa em `execCapture` — a variável vale só
 * para este processo `claude`, nunca vaza para outro comando do sandbox.
 * Ausente ou vazio (o caso de hoje, Provedor `anthropic`): nenhum prefixo
 * entra nos args, e a invocação sai idêntica à de antes desta issue.
 */
export function runClaudeStreaming(name, { workdir, prompt, model, extraArgs = [], env = {}, onChunk }) {
  const claudeArgs = [
    "claude",
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--model", model,
    "--permission-mode", "bypassPermissions",
    ...extraArgs,
    prompt,
  ];
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const args = ["sandbox", "exec", "-w", workdir, name, ...(envArgs.length ? ["env", ...envArgs] : []), ...claudeArgs];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => onChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Caminho, dentro do container, de um caminho do host. */
export const inContainer = toContainerPath;

/** Caminho do bootstrap dentro do container (o Ralph é montado read-only). */
export function bootstrapScriptPath() {
  return toContainerPath(path.join(ralphHome(), "sandbox", "bootstrap.sh"));
}
