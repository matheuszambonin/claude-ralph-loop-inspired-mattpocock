import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ralphHome } from "../src/paths.mjs";

/**
 * Estes três comportamentos vivem inteiros dentro do `cmdInit` — não há costura
 * pura onde prová-los, e são justamente os que apagam trabalho do operador
 * quando quebram (issue #48). Roda o CLI de verdade num diretório temporário,
 * com `node:child_process` da biblioteca padrão: nenhuma dependência nova,
 * nenhum Docker envolvido (`init` não toca no sandbox).
 */
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function tmpTarget(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ralph(root, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

const configOf = (root) => JSON.parse(readFileSync(path.join(root, ".ralph", "config.json"), "utf8"));
const promptOf = (root) => readFileSync(path.join(root, ".ralph", "prompt.md"), "utf8");
const templateOf = (name) => readFileSync(path.join(ralphHome(), "prompts", `${name}.md`), "utf8");

test("init --prompt orientation recusa e diz quais são os prompts de iteração", (t) => {
  const root = tmpTarget(t);
  const { code, err } = ralph(root, "init", "--prompt", "orientation");
  assert.equal(code, 1);
  assert.match(err, /não é um prompt de iteração/);
  assert.match(err, /implement\|entropy\|test-coverage/);
});

test("init --force preserva o config do repo em vez de reescrevê-lo dos DEFAULTS", (t) => {
  const root = tmpTarget(t);
  ralph(root, "init");
  const cfg = configOf(root);
  cfg.nightProvider = { ...cfg.nightProvider, baseUrl: "http://meu-ollama:11434" };
  cfg.model = "opus";
  writeFileSync(path.join(root, ".ralph", "config.json"), JSON.stringify(cfg, null, 2), "utf8");

  ralph(root, "init", "--force");
  const after = configOf(root);
  assert.equal(after.nightProvider.baseUrl, "http://meu-ollama:11434");
  assert.equal(after.model, "opus");
});

test("init --force sem --prompt re-sincroniza o template instalado, não o implement", (t) => {
  const root = tmpTarget(t);
  ralph(root, "init", "--prompt", "entropy");
  writeFileSync(path.join(root, ".ralph", "prompt.md"), templateOf("entropy") + "\nlinha derivada\n", "utf8");

  ralph(root, "init", "--force");
  assert.equal(promptOf(root), templateOf("entropy"));
});

test("init --force preserva o prompt que o operador reivindicou como custom", (t) => {
  const root = tmpTarget(t);
  ralph(root, "init");
  const mine = "<!-- ralph:prompt custom -->\n\nprompt do operador\n";
  mkdirSync(path.join(root, ".ralph"), { recursive: true });
  writeFileSync(path.join(root, ".ralph", "prompt.md"), mine, "utf8");

  const { out } = ralph(root, "init", "--force");
  assert.equal(promptOf(root), mine);
  assert.match(out, /custom/);
});
