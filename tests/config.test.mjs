import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, loadConfig, saveConfig, withOverrides } from "../src/config.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root, contents) {
  mkdirSync(path.join(root, ".ralph"), { recursive: true });
  writeFileSync(path.join(root, ".ralph", "config.json"), JSON.stringify(contents));
}

test("loadConfig: sem .ralph/config.json, nightProvider sai completo, com os seis campos", (t) => {
  const root = tmpRepo(t);
  const cfg = loadConfig(root);
  assert.deepEqual(cfg.nightProvider, DEFAULTS.nightProvider);
  assert.equal(Object.keys(cfg.nightProvider).length, 6);
});

test("loadConfig: config.json que só declara nightProvider.model herda baseUrl/keepAlive/minContext/probeTimeoutSeconds do padrão", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { model: "qwen2.5-coder:14b" } });
  const cfg = loadConfig(root);
  assert.equal(cfg.nightProvider.model, "qwen2.5-coder:14b");
  assert.equal(cfg.nightProvider.baseUrl, DEFAULTS.nightProvider.baseUrl);
  assert.equal(cfg.nightProvider.keepAlive, DEFAULTS.nightProvider.keepAlive);
  assert.equal(cfg.nightProvider.minContext, DEFAULTS.nightProvider.minContext);
  assert.equal(cfg.nightProvider.probeTimeoutSeconds, DEFAULTS.nightProvider.probeTimeoutSeconds);
});

// O teto do canário é do operador (issue #57): default generoso para quem não
// declara nada, e o valor declarado vence sem perder o resto do bloco.
test("loadConfig: probeTimeoutSeconds tem default generoso — night mode gasta tempo ocioso, não token pago", (t) => {
  const root = tmpRepo(t);
  assert.equal(loadConfig(root).nightProvider.probeTimeoutSeconds, 900);
});

test("loadConfig: probeTimeoutSeconds declarado vence o default e não derruba os outros campos", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { probeTimeoutSeconds: 1800 } });
  const cfg = loadConfig(root);
  assert.equal(cfg.nightProvider.probeTimeoutSeconds, 1800);
  assert.equal(cfg.nightProvider.model, DEFAULTS.nightProvider.model);
  assert.equal(cfg.nightProvider.minContext, DEFAULTS.nightProvider.minContext);
});

// O vizinho de bloco é `keepAlive: "8h"`, então "900s" é o erro provável. Sem
// esta guarda ele vira RangeException dentro da sonda, que as três provas
// engolem — e o operador recebe "troque nightProvider.model" por um typo no
// teto (issue #57).
test("loadConfig: probeTimeoutSeconds com unidade colada é erro de config, não misdiagnóstico da sonda", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { probeTimeoutSeconds: "900s" } });
  assert.throws(() => loadConfig(root), /probeTimeoutSeconds/);
});

test("loadConfig: o erro do teto torto diz como escrever o número certo", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { probeTimeoutSeconds: -1 } });
  assert.throws(() => loadConfig(root), /sem unidade|apague o campo/);
});

test("loadConfig: teto acima do que o AbortSignal aceita reprova antes de chegar na sonda", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { probeTimeoutSeconds: 1e12 } });
  assert.throws(() => loadConfig(root), /probeTimeoutSeconds/);
});

// Mesmo formato de erro do teto (issue #60), aplicado ao campo vizinho: o
// bloco tem `keepAlive: "8h"`, então `"128k"` é o erro provável. Sem a guarda,
// o canário monta o prompt a partir desse valor e estoura dentro da sonda, que
// engole exceção por prova — e o operador recebe "troque nightProvider.model"
// por um typo no contexto declarado.
test("loadConfig: minContext com unidade colada é erro de config, não misdiagnóstico da sonda", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { minContext: "128k" } });
  assert.throws(() => loadConfig(root), /minContext/);
});

test("loadConfig: minContext zero ou negativo reprova, e o erro diz o que escrever no lugar", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { minContext: 0 } });
  assert.throws(() => loadConfig(root), /nightProvider\.minContext é 0/);
  assert.throws(() => loadConfig(root), /sem unidade|apague o campo/);

  const other = tmpRepo(t);
  writeConfig(other, { nightProvider: { minContext: -1 } });
  assert.throws(() => loadConfig(other), /minContext/);
});

test("loadConfig: minContext que o canário não conseguiria montar reprova antes de chegar na sonda", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { minContext: 1e12 } });
  assert.throws(() => loadConfig(root), /minContext/);
});

test("loadConfig: minContext declarado vence o default e não derruba os outros campos", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { minContext: 65536 } });
  const cfg = loadConfig(root);
  assert.equal(cfg.nightProvider.minContext, 65536);
  assert.equal(cfg.nightProvider.model, DEFAULTS.nightProvider.model);
  assert.equal(cfg.nightProvider.probeTimeoutSeconds, DEFAULTS.nightProvider.probeTimeoutSeconds);
});

test("loadConfig: config.json que não menciona nightProvider continua válido, sem migração", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { model: "opus" });
  const cfg = loadConfig(root);
  assert.equal(cfg.model, "opus");
  assert.deepEqual(cfg.nightProvider, DEFAULTS.nightProvider);
});

test("loadConfig: nightProvider salvo com um campo só não perde os demais na próxima carga", (t) => {
  const root = tmpRepo(t);
  saveConfig(root, { nightProvider: { keepAlive: "30m" } });
  const cfg = loadConfig(root);
  assert.equal(cfg.nightProvider.keepAlive, "30m");
  assert.equal(cfg.nightProvider.model, DEFAULTS.nightProvider.model);
});

test("withOverrides: --night --model <tag> põe a tag no modelo do Provedor local, não em cfg.model", () => {
  const cfg = { ...DEFAULTS };
  const result = withOverrides(cfg, { night: true, model: "custom-tag" });
  assert.equal(result.night, true);
  assert.equal(result.nightProvider.model, "custom-tag");
  assert.equal(result.model, DEFAULTS.model);
});

test("withOverrides: --model <tag> sem --night põe a tag em cfg.model e não toca nightProvider", () => {
  const cfg = { ...DEFAULTS };
  const result = withOverrides(cfg, { model: "custom-tag" });
  assert.equal(result.model, "custom-tag");
  assert.deepEqual(result.nightProvider, DEFAULTS.nightProvider);
  assert.ok(!result.night);
});

test("withOverrides: --night --model <tag> sobre nightProvider já declarado preserva os demais campos", () => {
  const cfg = { ...DEFAULTS, nightProvider: { ...DEFAULTS.nightProvider, keepAlive: "30m" } };
  const result = withOverrides(cfg, { night: true, model: "custom-tag" });
  assert.equal(result.nightProvider.model, "custom-tag");
  assert.equal(result.nightProvider.keepAlive, "30m");
  assert.equal(result.nightProvider.baseUrl, DEFAULTS.nightProvider.baseUrl);
});

// O teto de uma iteração é do operador (issue #67), como o do canário: o
// default segura a noite inteira travada, e quem tem máquina lenta afrouxa.
test("loadConfig: iterationTimeoutSeconds tem default, e um afk largado à noite não fica sem teto", (t) => {
  const root = tmpRepo(t);
  assert.equal(loadConfig(root).iterationTimeoutSeconds, DEFAULTS.iterationTimeoutSeconds);
  assert.ok(DEFAULTS.iterationTimeoutSeconds > 0);
});

test("loadConfig: iterationTimeoutSeconds declarado vence o default", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { iterationTimeoutSeconds: 120 });
  assert.equal(loadConfig(root).iterationTimeoutSeconds, 120);
});

// "30m" não vira erro de config sozinho: viraria um setTimeout com NaN, que
// dispara na hora e mata toda iteração no primeiro instante.
test("loadConfig: iterationTimeoutSeconds com unidade colada é erro de config, não teto que dispara na hora", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { iterationTimeoutSeconds: "30m" });
  assert.throws(() => loadConfig(root), /iterationTimeoutSeconds/);
});

test("loadConfig: iterationTimeoutSeconds zero ou negativo reprova dizendo o que escrever no lugar", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { iterationTimeoutSeconds: 0 });
  assert.throws(() => loadConfig(root), /iterationTimeoutSeconds é 0/);
});

// Acima do que o setTimeout aceita, o timer dispara no ato — o mesmo teto que
// some, pelo outro extremo.
test("loadConfig: iterationTimeoutSeconds acima do que o setTimeout aceita reprova", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { iterationTimeoutSeconds: 1e12 });
  assert.throws(() => loadConfig(root), /iterationTimeoutSeconds/);
});
