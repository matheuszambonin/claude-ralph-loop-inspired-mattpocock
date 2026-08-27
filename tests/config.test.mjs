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
