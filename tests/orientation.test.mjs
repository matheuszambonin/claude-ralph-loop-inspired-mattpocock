import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderOrientationPrompt, buildOrientationAgent, buildOrientationPrompt } from "../src/orientation.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-orientation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseCfg() {
  return { progressFile: ".ralph/PROGRESS.md", blockedPromise: "BLOCKED" };
}

test("renderOrientationPrompt: resolve PROGRESS_FILE, BLOCKED_PROMISE e o bloco do índice", () => {
  const result = renderOrientationPrompt(
    "{{PROGRESS_FILE}} / {{BLOCKED_PROMISE}}\n{{KNOWLEDGE_INDEX_BLOCK}}\ndepois",
    baseCfg(),
    "Knowledge index detected — consult it before you grep:\n- graphify\n"
  );
  assert.equal(
    result,
    ".ralph/PROGRESS.md / BLOCKED\nKnowledge index detected — consult it before you grep:\n- graphify\ndepois"
  );
});

test("renderOrientationPrompt: sem índice, o placeholder some sem deixar linha em branco", () => {
  const result = renderOrientationPrompt("antes\n{{KNOWLEDGE_INDEX_BLOCK}}\ndepois", baseCfg(), "");
  assert.equal(result, "antes\ndepois");
});

test("buildOrientationAgent: usa o modelo do config", () => {
  const agent = buildOrientationAgent("prompt de teste", { scoutModel: "sonnet" });
  assert.equal(agent.orientation.model, "sonnet");
});

test("buildOrientationAgent: sem scoutModel no config, o padrão é haiku", () => {
  const agent = buildOrientationAgent("prompt de teste", {});
  assert.equal(agent.orientation.model, "haiku");
});

test("buildOrientationAgent: não expõe Edit nem Write", () => {
  const agent = buildOrientationAgent("prompt de teste", {});
  assert.ok(!agent.orientation.tools.includes("Edit"));
  assert.ok(!agent.orientation.tools.includes("Write"));
});

test("buildOrientationAgent: carrega o prompt recebido sem alterar", () => {
  const agent = buildOrientationAgent("prompt de teste", {});
  assert.equal(agent.orientation.prompt, "prompt de teste");
});

test("buildOrientationPrompt: repositório com índice de conhecimento — o bloco aparece no prompt do subagente", (t) => {
  const root = tmpRepo(t);
  mkdirSync(path.join(root, ".code-review-graph"), { recursive: true });
  writeFileSync(path.join(root, ".code-review-graph", "graph.db"), "");

  const result = buildOrientationPrompt(root, baseCfg());
  assert.match(result, /Knowledge index detected/);
});

test("buildOrientationPrompt: repositório sem índice de conhecimento — sem sobra de placeholder", (t) => {
  const root = tmpRepo(t);
  const result = buildOrientationPrompt(root, baseCfg());
  assert.doesNotMatch(result, /KNOWLEDGE_INDEX_BLOCK/);
  assert.doesNotMatch(result, /Knowledge index detected/);
});
