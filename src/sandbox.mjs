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
 * O único endereço que o proxy do sandbox precisa deixar passar para o
 * Provedor local e para a sonda de embeddings alcançarem o host (issue #52).
 *
 * Todo o tráfego do sandbox atravessa um proxy MITM, e é o proxy — não o
 * container — quem resolve `host.docker.internal`: do lado dele o nome cai em
 * `localhost`, e ele tenta `::1` antes do IPv4. A política default do
 * `docker sandbox` bloqueia `::1/128`, então o pedido morre em 500 sem nunca
 * tentar o IPv4, onde o Ollama do host está escutando.
 *
 * É um CIDR e não um host porque as variantes estreitas não funcionam —
 * medido em dois sandboxes: `--allow-host host.docker.internal`,
 * `--allow-host "::1"` e `--allow-host "[::1]:11434"` seguem em 500, porque
 * `--allow-host` não vence um bloqueio de CIDR. Não há granularidade de porta
 * disponível, então o que se abre é o loopback do host inteiro: o agente passa
 * a alcançar qualquer serviço que escute em `localhost` na sua máquina. Por
 * isso quem chama anuncia, como `ralph login --share-credentials` anuncia.
 */
export const HOST_LOOPBACK_CIDR = "::1/128";

/**
 * Abre a rota do sandbox até o loopback do host. Idempotente — repetir a regra
 * é o caso normal, não erro.
 *
 * Sem isso o sandbox nasce sem rota até o host e **nada** no Ralph a abre: não
 * é intermitência, é todo sandbox novo, e derruba de uma vez o Provedor do
 * night mode e a sonda de embeddings do code-review-graph, que roda em todo
 * loop. O diagnóstico das issues #13, #19 e #47 estava certo em dizer "falhou";
 * o que faltava era a rota existir.
 */
export async function allowHostLoopback(name, { dockerImpl = docker } = {}) {
  await dockerImpl(["sandbox", "network", "proxy", name, "--allow-cidr", HOST_LOOPBACK_CIDR]);
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
 * Sistema de arquivos que um disco local reporta na única plataforma onde esta
 * sonda roda. Tudo que difere disso num workspace do sandbox vira aviso.
 */
const LOCAL_DISK_FILESYSTEM = "NTFS";

/** Campo de texto vindo de fora: string aparada, ou "" para qualquer outra coisa. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Letra do volume do host, aceitando as três formas que circulam por aqui: o
 * caminho de um workspace (`G:\\repo`), o `DeviceID` do Windows (`G:`) e a
 * própria letra (`G`). "" quando não há nenhuma — o caso de Linux, macOS e o
 * de um caminho UNC.
 */
function volumeLetterOf(value) {
  const m = /^([A-Za-z])(?::|$)/.exec(text(value));
  return m ? m[1].toUpperCase() : "";
}

/**
 * Volumes do host onde os workspaces do sandbox vivem (issue #27). Ponto
 * impuro fino e Windows-only de propósito: é onde a falha de virtiofs foi
 * observada e onde existe letra de volume. Em qualquer outra plataforma
 * devolve nada e o doctor fica em silêncio — um ramo para Linux e macOS seria
 * calibrado no escuro, e `describeSandboxCreateFailure` já traduz o erro real
 * lá quando o caso aparecer.
 *
 * Nunca lança: PowerShell ausente, timeout, política de execução ou JSON
 * inválido são ausência de fatos, não exceção. Esta é uma checagem de
 * diagnóstico — derrubar o `doctor` por causa dela seria pior do que calar.
 *
 * O que entrega o volume é o sistema de arquivos, não o tipo de drive: o
 * Google Drive File Stream se apresenta como disco fixo (`DriveType 3`) e
 * reporta `FAT32`.
 */
export async function collectHostVolumes({ platform = process.platform, execImpl = execFileAsync } = {}) {
  if (platform !== "win32") return [];
  try {
    const { stdout } = await execImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,FileSystem,VolumeName | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((row) => row && typeof row === "object")
      .map((row) => ({ letter: volumeLetterOf(row.DeviceID), fileSystem: text(row.FileSystem), label: text(row.VolumeName) }));
  } catch {
    return [];
  }
}

/**
 * Uma linha de aviso por volume do host que abriga workspace do sandbox e não
 * reporta sistema de arquivos de disco local (issue #27). Pura: recebe a mesma
 * lista de mounts que o `create` usa e os fatos colhidos, devolve texto — o
 * teste não depende de qual disco a máquina que roda os testes tem.
 *
 * A linha relata o fato colhido e o que se sabe sobre ele; não prevê o
 * futuro. Sai como aviso e nunca como falha porque um volume exótico pode
 * muito bem funcionar, e quem lê julga se o caso é o dele.
 *
 * Volume sem sistema de arquivos reportado não vira aviso: "não reportou" não
 * é o mesmo que "não é NTFS", e avisar sobre ausência de dado seria o aviso
 * falso que esta checagem existe para não dar.
 */
export function describeWorkspacesOutsideLocalDisk(mounts, volumes) {
  const letters = new Set((mounts ?? []).map(volumeLetterOf).filter(Boolean));
  return (volumes ?? [])
    .filter((v) => v && typeof v === "object")
    .map((v) => ({ letter: volumeLetterOf(v.letter), fileSystem: text(v.fileSystem), label: text(v.label) }))
    .filter((v) => letters.has(v.letter) && v.fileSystem && v.fileSystem.toUpperCase() !== LOCAL_DISK_FILESYSTEM)
    .map(
      (v) =>
        `workspace do sandbox no volume ${v.letter}: — sistema de arquivos ${v.fileSystem}, ` +
        `rótulo ${v.label ? `"${v.label}"` : "sem rótulo"}; disco local no Windows reporta ${LOCAL_DISK_FILESYSTEM}.\n` +
        "  O compartilhamento de arquivos do docker sandbox é virtiofs, e criar sandbox com workspace num volume\n" +
        "  que reporta FAT32 e disco fixo — como o Google Drive File Stream se apresenta — já foi observado\n" +
        "  terminando em EINVAL (issue #24). Se for esse o caso deste volume, um clone em disco local é a saída."
    );
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
  // Depois do create e não a cada chamada: a regra persiste no sandbox, e
  // reaplicá-la em toda iteração custaria um `docker` a mais por um estado que
  // já está lá. Sandbox criado antes desta issue se recupera pelo
  // `ralph bootstrap --force`.
  await allowHostLoopback(name);
  process.stdout.write(describeHostLoopbackOpened());
  return true;
}

/**
 * O que a abertura da rota custa, dito na hora em que ela acontece — mesma
 * família do aviso de `ralph login --share-credentials`, e pelo mesmo motivo:
 * o Ralph está ampliando o que o agente alcança, e ampliação silenciosa é a
 * que o operador descobre tarde.
 */
export function describeHostLoopbackOpened() {
  return (
    "! rota do sandbox até o loopback do host aberta — sem ela o Provedor local e a busca semântica não\n" +
    "  alcançam a sua máquina. O agente passa a alcançar qualquer serviço que escute em localhost.\n"
  );
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
 *
 * `timeoutMs` (issue #67) é o teto da iteração: estourado, o processo do
 * `docker sandbox exec` morre e a promise resolve com `timedOut: true`. Quem
 * chama decide o que fazer com isso — aqui não há política, só o relógio.
 * Zero ou ausente mantém o comportamento de antes: espera indefinida.
 *
 * `spawnImpl` existe pelo mesmo motivo do `dockerImpl` de
 * `allowHostLoopback`: é por onde o teste do teto prova que o processo
 * morre, sem precisar de um Docker de verdade para travar de propósito.
 */
export function runClaudeStreaming(name, { workdir, prompt, model, extraArgs = [], env = {}, timeoutMs = 0, onChunk, abortWhen, spawnImpl = spawn }) {
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
    const child = spawnImpl("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let timer = null;
    let settled = false;

    /**
     * Resolve uma vez só e larga o filho. Medido em 28/08/2026 contra o
     * sandbox `ralph-ralph-1pp906k`: matar o cliente do `docker sandbox exec`
     * **não** produz `close` — ele deixa processos para trás segurando os
     * pipes, e o Node só emite `close` quando o stdio fecha. Uma promise que
     * esperasse esse evento trocaria a espera infinita por outra.
     */
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      resolve({ code, stderr, timedOut, aborted });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        settle(1);
      }, timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      onChunk(chunk);
      // Depois do chunk, nunca antes: quem decide o corte lê o estado que este
      // mesmo chunk acabou de alimentar (issue #74). Mata pelo caminho do teto
      // de tempo — o `claude` do container ainda precisa do `killClaudeInSandbox`
      // de quem chamou, e é por isso que o resultado diz qual dos dois cortou.
      if (settled || !abortWhen?.()) return;
      aborted = true;
      child.kill();
      settle(1);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => settle(code ?? 1));
  });
}

/**
 * Mata o `claude` de dentro do sandbox. Matar o cliente `docker sandbox exec`
 * do lado do host não basta: o processo do container não recebe o sinal e
 * segue trabalhando no repo montado — gastando token e ainda podendo commitar
 * depois que o Ralph já desistiu da iteração (issue #67). O padrão de
 * argumentos é o da invocação de `runClaudeStreaming`, não `claude` solto, para
 * não derrubar uma sessão interativa que o operador tenha aberto no mesmo
 * sandbox. Sem correspondência o `pkill` sai 1, e isso aqui é o caso normal —
 * o cliente morto pode ter levado o processo junto.
 */
export async function killClaudeInSandbox(name) {
  // Com teto próprio: este `exec` é o mesmo tipo de processo que acabou de não
  // responder, e um Ralph pendurado na limpeza fica pior do que sem teto
  // nenhum. Trinta segundos é folgado para um `pkill`.
  await Promise.race([
    execCapture(name, ["pkill", "-f", "claude --print"]),
    new Promise((r) => setTimeout(r, 30_000).unref()),
  ]);
}

/** Caminho, dentro do container, de um caminho do host. */
export const inContainer = toContainerPath;

/** Caminho do bootstrap dentro do container (o Ralph é montado read-only). */
export function bootstrapScriptPath() {
  return toContainerPath(path.join(ralphHome(), "sandbox", "bootstrap.sh"));
}

/**
 * Primeira versão do `gh` que lê uma issue sem pedir `repository.issue.
 * projectCards`, o campo que o GitHub aposentou junto com os Projects
 * (classic). Abaixo dela `gh issue view <n> --comments` sai 1 com erro de
 * GraphQL — e é esse o comando que `docs/agents/issue-tracker.md` prescreve
 * para ler um ticket (issue #80). Apurado em cli/cli: o commit 5ec2160b
 * ("Avoid requesting projectCards for issue view") está em v2.71.0 e não em
 * v2.70.0.
 */
export const GH_MIN_VERSION = "2.71.0";

/** [major, minor, patch] do primeiro `x.y.z` do texto; [] quando não há nenhum. */
function versionTuple(value) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(typeof value === "string" ? value : "");
  return m ? m.slice(1, 4).map(Number) : [];
}

/** Negativo, zero ou positivo, comparando número a número — "2.100" > "2.9". */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * O que o `doctor` diz sobre o `gh` que existe dentro do sandbox, a partir da
 * saída de `gh --version`. Pura: recebe texto, devolve `{ level, message }` —
 * mesma forma de `describeDrift`.
 *
 * É aqui, e não no `bootstrap.sh`, que o piso é cobrado: a instalação lá não
 * derruba o sandbox quando falha, então alguém precisa dizer depois se ela
 * pegou. Vale também para os sandboxes criados antes desta issue — o bootstrap
 * é carimbado, roda uma vez por sandbox, e nada no loop troca o `gh` sozinho.
 * Sem esta linha o operador só descobre a versão velha pelo estrago: uma
 * Orientação que não conseguiu ler o ticket e escreveu mesmo assim.
 *
 * Sem versão legível não sai linha nenhuma: `gh` ausente ou quebrado é o que a
 * checagem de `gh auth status`, ao lado desta no `doctor`, já reprova — um
 * segundo diagnóstico para o mesmo fato só duplicaria o barulho.
 */
export function describeSandboxGh(versionOutput) {
  const seen = versionTuple(versionOutput);
  if (!seen.length) return null;
  const version = seen.join(".");
  if (compareVersions(seen, versionTuple(GH_MIN_VERSION)) >= 0) {
    return { level: "ok", message: `gh ${version} no sandbox` };
  }
  return {
    level: "warn",
    message:
      `gh ${version} no sandbox, abaixo de ${GH_MIN_VERSION} — nessa faixa 'gh issue view <n> --comments'\n` +
      "  reprova pedindo projectCards, campo que o GitHub aposentou, e a leitura de ticket morre lá dentro.\n" +
      "  Rode 'ralph bootstrap --force' para instalar o gh do repositório oficial.",
  };
}
