import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  describeSandboxCreateFailure,
  allowHostLoopback,
  describeHostLoopbackOpened,
  HOST_LOOPBACK_CIDR,
  runClaudeStreaming,
  describeWorkspacesOutsideLocalDisk,
  collectHostVolumes,
  describeSandboxGh,
  GH_MIN_VERSION,
} from "../src/sandbox.mjs";

const VIRTIOFS_PANIC =
  "create runtime: create/start VM: POST VM create failed: status 500:\n" +
  "panic detected in openvmm: failed to resolve resource of type virtio:virtiofs: EINVAL (22)";

test("describeSandboxCreateFailure: assinatura de virtiofs nomeia o compartilhamento de arquivos do docker sandbox e aponta a saída em disco local", () => {
  const line = describeSandboxCreateFailure({ code: 1, stderr: VIRTIOFS_PANIC, mounts: ["/c/repo"] });
  assert.match(line, /docker sandbox/);
  assert.match(line, /compartilhamento de arquivos/);
  assert.match(line, /clone.*disco local/);
});

test("describeSandboxCreateFailure: lista os workspaces recebidos", () => {
  const mounts = ["/c/repo", "/c/plugins:ro", "/c/ralph:ro"];
  const line = describeSandboxCreateFailure({ code: 1, stderr: VIRTIOFS_PANIC, mounts });
  for (const m of mounts) assert.match(line, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("describeSandboxCreateFailure: stderr de outro erro qualquer devolve a mensagem de hoje, com o código de saída", () => {
  const line = describeSandboxCreateFailure({ code: 1, stderr: "algum outro erro qualquer", mounts: ["/c/repo"] });
  assert.match(line, /código 1/);
  assert.doesNotMatch(line, /compartilhamento de arquivos/);
});

test("describeSandboxCreateFailure: stderr vazio não quebra e ainda devolve o código de saída", () => {
  const line = describeSandboxCreateFailure({ code: 1, stderr: "", mounts: ["/c/repo"] });
  assert.match(line, /código 1/);
});

test("describeSandboxCreateFailure: stderr ausente (null/undefined) não quebra e ainda devolve o código de saída", () => {
  assert.match(describeSandboxCreateFailure({ code: 1, stderr: null, mounts: ["/c/repo"] }), /código 1/);
  assert.match(describeSandboxCreateFailure({ code: 1, stderr: undefined, mounts: ["/c/repo"] }), /código 1/);
});

test("describeSandboxCreateFailure: a assinatura casa mesmo com o texto de panic ao redor variando", () => {
  const stderrV1 =
    "some noisy preamble from an older openvmm build\n" +
    "failed to resolve resource of type virtio:virtiofs: EINVAL (22)\nmore trailing noise";
  const stderrV2 =
    "create/start VM: POST VM create failed: status 500: totally different wrapper text " +
    "around virtio:virtiofs and EINVAL somewhere in the middle of the line";
  assert.match(describeSandboxCreateFailure({ code: 1, stderr: stderrV1, mounts: [] }), /compartilhamento de arquivos/);
  assert.match(describeSandboxCreateFailure({ code: 1, stderr: stderrV2, mounts: [] }), /compartilhamento de arquivos/);
});

// --- a rota do sandbox até o loopback do host (issue #52) ---

test("allowHostLoopback: libera o CIDR, não o host — --allow-host não vence um bloqueio de CIDR", async () => {
  let argv = null;
  await allowHostLoopback("ralph-alvo-1abc", { dockerImpl: async (a) => (argv = a) });
  assert.deepEqual(argv, ["sandbox", "network", "proxy", "ralph-alvo-1abc", "--allow-cidr", "::1/128"]);
});

test("allowHostLoopback: o CIDR é o loopback IPv6, para onde o proxy resolve host.docker.internal", () => {
  // Medido na issue #52: o proxy tenta ::1 antes do IPv4 e a política default
  // bloqueia esse endereço, então o pedido morre em 500 sem chegar ao Ollama.
  assert.equal(HOST_LOOPBACK_CIDR, "::1/128");
});

test("describeHostLoopbackOpened: anuncia o que a rota amplia, não só que abriu", () => {
  const msg = describeHostLoopbackOpened();
  assert.match(msg, /localhost/);
  assert.match(msg, /alcançar/);
});

/**
 * Processo de mentira no lugar do `docker sandbox exec`: streams de verdade
 * para o código sob teste tratá-lo como trata o filho real, e um `kill` que
 * registra o sinal em vez de matar coisa nenhuma.
 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal = "SIGTERM") => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

// Medido em 28/08/2026: matar o cliente do `docker sandbox exec` não produz
// `close` — ele deixa processos para trás segurando os pipes. Por isso o filho
// de mentira não fecha sozinho: é assim que o real se comporta.
test("runClaudeStreaming: estourado o teto, o processo é morto e a promise resolve sem esperar o close", async () => {
  const child = fakeChild();
  const res = await runClaudeStreaming("sandbox-de-mentira", {
    workdir: "/repo",
    prompt: "trabalhe",
    model: "sonnet",
    timeoutMs: 20,
    onChunk: () => {},
    spawnImpl: () => child,
  });
  assert.equal(res.timedOut, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  // Quem chama trata o estouro pelo mesmo caminho de `code !== 0`.
  assert.notEqual(res.code, 0);
});

test("runClaudeStreaming: iteração que termina antes do teto sai limpa, e o teto não dispara depois", async () => {
  const child = fakeChild();
  setTimeout(() => child.emit("close", 0), 5);
  const res = await runClaudeStreaming("sandbox-de-mentira", {
    workdir: "/repo",
    prompt: "trabalhe",
    model: "sonnet",
    timeoutMs: 10_000,
    onChunk: () => {},
    spawnImpl: () => child,
  });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.deepEqual(child.signals, []);
});

test("runClaudeStreaming: sem teto declarado, a espera segue indefinida — o comportamento de antes da issue #67", async () => {
  const child = fakeChild();
  setTimeout(() => child.emit("close", 0), 30);
  const res = await runClaudeStreaming("sandbox-de-mentira", {
    workdir: "/repo",
    prompt: "trabalhe",
    model: "sonnet",
    timeoutMs: 0,
    onChunk: () => {},
    spawnImpl: () => child,
  });
  assert.equal(res.code, 0);
  assert.deepEqual(child.signals, []);
});


test("runClaudeStreaming: sem `abortWhen`, a iteração corre como antes da issue #74", async () => {
  const child = fakeChild();
  setTimeout(() => {
    child.stdout.write('{"type":"assistant"}\n');
    child.emit("close", 0);
  }, 5);
  const res = await runClaudeStreaming("sandbox-de-mentira", {
    workdir: "/repo",
    prompt: "trabalhe",
    model: "sonnet",
    timeoutMs: 10_000,
    onChunk: () => {},
    spawnImpl: () => child,
  });
  assert.equal(res.code, 0);
  assert.equal(res.aborted, false);
  assert.deepEqual(child.signals, []);
});
test("runClaudeStreaming: `abortWhen` corta a iteração como o teto corta, e diz que foi corte (issue #74)", async () => {
  const child = fakeChild();
  let chunks = 0;
  setTimeout(() => {
    child.stdout.write('{"type":"assistant"}\n');
    child.stdout.write('{"type":"assistant"}\n');
  }, 5);
  const res = await runClaudeStreaming("sandbox-de-mentira", {
    workdir: "/repo",
    prompt: "trabalhe",
    model: "sonnet",
    timeoutMs: 10_000,
    onChunk: () => chunks++,
    // O laço só aparece depois de a Orientação já ter rodado um tanto; aqui,
    // depois do segundo pedaço de stdout.
    abortWhen: () => chunks >= 2,
    spawnImpl: () => child,
  });
  assert.equal(res.aborted, true);
  // Não é estouro de teto: quem lê o resultado precisa distinguir os dois.
  assert.equal(res.timedOut, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.notEqual(res.code, 0);
});

// --- volumes dos workspaces do sandbox (issue #27) ---

const LOCAL = { letter: "C", fileSystem: "NTFS", label: "" };
const DRIVE = { letter: "G", fileSystem: "FAT32", label: "matheus@exemplo.com" };

test("describeWorkspacesOutsideLocalDisk: sem fatos colhidos, nenhuma linha — é o caso de Linux, macOS e o da sonda que não conseguiu", () => {
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["C:\\repo"], []), []);
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["C:\\repo"], null), []);
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["C:\\repo"], undefined), []);
});

test("describeWorkspacesOutsideLocalDisk: todos os workspaces em disco local, nenhuma linha — a saída do doctor fica idêntica à de hoje", () => {
  const mounts = ["C:\\repo", "C:\\Users\\x\\.claude\\plugins:ro", "C:\\Tools\\Ralph:ro"];
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(mounts, [LOCAL, DRIVE]), []);
});

test("describeWorkspacesOutsideLocalDisk: volume com sistema de arquivos inesperado cita a letra, o sistema de arquivos e o rótulo", () => {
  const [line, ...rest] = describeWorkspacesOutsideLocalDisk(["G:\\repo"], [LOCAL, DRIVE]);
  assert.deepEqual(rest, []);
  assert.match(line, /G:/);
  assert.match(line, /FAT32/);
  assert.match(line, /matheus@exemplo\.com/);
  assert.match(line, /NTFS/);
});

test("describeWorkspacesOutsideLocalDisk: a linha relata o que foi colhido e não afirma que a criação do sandbox vai falhar", () => {
  const [line] = describeWorkspacesOutsideLocalDisk(["G:\\repo"], [DRIVE]);
  assert.doesNotMatch(line, /vai falhar|falhará|não vai funcionar|não funcionará|não vai dar|impossível/i);
  // O tom pelo lado positivo, para uma reescrita futura não passar batida: o
  // que se afirma é o que já foi observado, e a conclusão fica condicionada.
  assert.match(line, /já observado/);
  assert.match(line, /Se for esse o caso/);
});

test("describeWorkspacesOutsideLocalDisk: cobre todos os workspaces, não só o repositório alvo", () => {
  const mounts = ["C:\\repo", "G:\\Meu Drive\\plugins:ro", "C:\\Tools\\Ralph:ro"];
  const [line, ...rest] = describeWorkspacesOutsideLocalDisk(mounts, [LOCAL, DRIVE]);
  assert.deepEqual(rest, []);
  assert.match(line, /G:/);
});

test("describeWorkspacesOutsideLocalDisk: um volume suspeito produz uma linha só, mesmo com vários workspaces nele", () => {
  const lines = describeWorkspacesOutsideLocalDisk(["G:\\repo", "G:\\plugins:ro", "I:\\extra"], [
    DRIVE,
    { letter: "I", fileSystem: "FAT32", label: "outra conta" },
  ]);
  assert.equal(lines.length, 2);
});

test("describeWorkspacesOutsideLocalDisk: volume com campos ausentes ou vazios não quebra a montagem da linha", () => {
  const [line] = describeWorkspacesOutsideLocalDisk(["G:\\repo"], [{ letter: "G", fileSystem: "FAT32" }]);
  assert.match(line, /G:/);
  assert.match(line, /FAT32/);
  assert.doesNotMatch(line, /undefined|null/);

  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["G:\\repo"], [{ letter: "G", fileSystem: "", label: "" }]), []);
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["G:\\repo"], [{}, null, "lixo"]), []);
});

test("describeWorkspacesOutsideLocalDisk: mounts ausentes ou sem letra de volume não quebram", () => {
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(null, [DRIVE]), []);
  assert.deepEqual(describeWorkspacesOutsideLocalDisk(["/home/x/repo", "", null], [DRIVE]), []);
});

test("describeWorkspacesOutsideLocalDisk: a letra do workspace casa com a do volume sem depender de caixa", () => {
  const [line] = describeWorkspacesOutsideLocalDisk(["g:\\repo"], [{ letter: "g", fileSystem: "exFAT", label: "" }]);
  assert.match(line, /exFAT/);
});

test("describeWorkspacesOutsideLocalDisk: FAT32 é o caso já observado, nunca o sistema de arquivos deste volume", () => {
  const [line] = describeWorkspacesOutsideLocalDisk(["g:"], [{ letter: "g", fileSystem: "exFAT", label: "" }]);
  assert.match(line, /sistema de arquivos exFAT/);
  assert.ok(
    line.indexOf("FAT32") > line.indexOf("caso já observado"),
    "FAT32 precisa vir depois da atribuição ao caso observado, e não descrever o volume colhido",
  );
});

test("describeWorkspacesOutsideLocalDisk: `letter` vale tanto como letra crua quanto como DeviceID do Windows", () => {
  const [comLetra] = describeWorkspacesOutsideLocalDisk(["G:\\repo"], [{ letter: "G", fileSystem: "FAT32", label: "" }]);
  const [comDeviceId] = describeWorkspacesOutsideLocalDisk(["G:\\repo"], [{ letter: "G:", fileSystem: "FAT32", label: "" }]);
  assert.equal(comLetra, comDeviceId);
});

test("collectHostVolumes: fora do Windows não colhe nada e não roda processo nenhum", async () => {
  let called = false;
  const volumes = await collectHostVolumes({
    platform: "linux",
    execImpl: async () => ((called = true), { stdout: "[]" }),
  });
  assert.deepEqual(volumes, []);
  assert.equal(called, false);
});

test("collectHostVolumes: PowerShell ausente, timeout ou política de execução viram ausência de fatos, não exceção", async () => {
  const boom = async () => {
    throw new Error("spawn powershell.exe ENOENT");
  };
  assert.deepEqual(await collectHostVolumes({ platform: "win32", execImpl: boom }), []);
});

test("collectHostVolumes: JSON inválido vira ausência de fatos, não exceção", async () => {
  const noise = async () => ({ stdout: "Get-CimInstance : Acesso negado\n" });
  assert.deepEqual(await collectHostVolumes({ platform: "win32", execImpl: noise }), []);
});

test("collectHostVolumes: normaliza a saída do PowerShell, inclusive o objeto solto de um volume só", async () => {
  const one = async () => ({ stdout: JSON.stringify({ DeviceID: "G:", FileSystem: "FAT32", VolumeName: "conta" }) });
  assert.deepEqual(await collectHostVolumes({ platform: "win32", execImpl: one }), [
    { letter: "G", fileSystem: "FAT32", label: "conta" },
  ]);
});

test("collectHostVolumes: campos ausentes na saída viram string vazia, nunca undefined", async () => {
  const partial = async () => ({ stdout: JSON.stringify([{ DeviceID: "C:" }, { FileSystem: "NTFS" }]) });
  assert.deepEqual(await collectHostVolumes({ platform: "win32", execImpl: partial }), [
    { letter: "C", fileSystem: "", label: "" },
    { letter: "", fileSystem: "NTFS", label: "" },
  ]);
});

const GH_UBUNTU = "gh version 2.46.0 (2025-12-13 Ubuntu 2.46.0-4)";
const GH_OFICIAL = "gh version 2.98.0 (2026-08-20)";

test("describeSandboxGh: o gh da imagem do Ubuntu é velho demais e o aviso diz o comando que conserta", () => {
  const { level, message } = describeSandboxGh(GH_UBUNTU);
  assert.equal(level, "warn");
  assert.match(message, /2\.46\.0/);
  assert.match(message, new RegExp(GH_MIN_VERSION.replace(/\./g, "\\.")));
  assert.match(message, /projectCards/);
  assert.match(message, /ralph bootstrap --force/);
});

test("describeSandboxGh: versão a partir do piso passa, e a linha nomeia a versão vista", () => {
  const { level, message } = describeSandboxGh(GH_OFICIAL);
  assert.equal(level, "ok");
  assert.match(message, /2\.98\.0/);
});

test("describeSandboxGh: o piso é a primeira versão que corrigiu, não a seguinte", () => {
  assert.equal(describeSandboxGh(`gh version ${GH_MIN_VERSION} (2025-04-23)`).level, "ok");
  assert.equal(describeSandboxGh("gh version 2.70.9 (2025-04-22)").level, "warn");
});

test("describeSandboxGh: compara número a número, não texto a texto", () => {
  assert.equal(describeSandboxGh("gh version 2.100.0 (2026-12-01)").level, "ok");
  assert.equal(describeSandboxGh("gh version 10.0.0 (2027-01-01)").level, "ok");
  assert.equal(describeSandboxGh("gh version 2.9.0 (2022-01-01)").level, "warn");
});

test("describeSandboxGh: sem versão legível não há fato para relatar, e nada é dito", () => {
  assert.equal(describeSandboxGh(""), null);
  assert.equal(describeSandboxGh("bash: gh: command not found"), null);
  assert.equal(describeSandboxGh(undefined), null);
});
