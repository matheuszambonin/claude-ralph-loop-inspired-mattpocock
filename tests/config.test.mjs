import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, loadConfig, saveConfig } from "../src/config.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root, contents) {
  mkdirSync(path.join(root, ".ralph"), { recursive: true });
  writeFileSync(path.join(root, ".ralph", "config.json"), JSON.stringify(contents));
}

test("loadConfig: sem .ralph/config.json, nightProvider sai completo, com os cinco campos", (t) => {
  const root = tmpRepo(t);
  const cfg = loadConfig(root);
  assert.deepEqual(cfg.nightProvider, DEFAULTS.nightProvider);
  assert.equal(Object.keys(cfg.nightProvider).length, 5);
});

test("loadConfig: config.json que só declara nightProvider.model herda baseUrl/keepAlive/minContext do padrão", (t) => {
  const root = tmpRepo(t);
  writeConfig(root, { nightProvider: { model: "qwen2.5-coder:14b" } });
  const cfg = loadConfig(root);
  assert.equal(cfg.nightProvider.model, "qwen2.5-coder:14b");
  assert.equal(cfg.nightProvider.baseUrl, DEFAULTS.nightProvider.baseUrl);
  assert.equal(cfg.nightProvider.keepAlive, DEFAULTS.nightProvider.keepAlive);
  assert.equal(cfg.nightProvider.minContext, DEFAULTS.nightProvider.minContext);
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
