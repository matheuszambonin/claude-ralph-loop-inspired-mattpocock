import test from "node:test";
import assert from "node:assert/strict";
import { describeSandboxCreateFailure } from "../src/sandbox.mjs";

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
