import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describeSandboxCreateFailure, allowHostLoopback, describeHostLoopbackOpened, HOST_LOOPBACK_CIDR, runClaudeStreaming } from "../src/sandbox.mjs";

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
