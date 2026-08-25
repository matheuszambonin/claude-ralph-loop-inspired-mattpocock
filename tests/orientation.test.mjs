import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderOrientationPrompt, buildOrientationAgent, buildOrientationPrompt, readOrientationTemplate } from "../src/orientation.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-orientation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseCfg() {
  return { progressFile: ".ralph/PROGRESS.md", blockedPromise: "BLOCKED" };
}

test("renderOrientationPrompt: resolve PROGRESS_FILE e o bloco do índice", () => {
  const result = renderOrientationPrompt(
    "{{PROGRESS_FILE}}\n{{KNOWLEDGE_INDEX_BLOCK}}\ndepois",
    baseCfg(),
    "Knowledge index detected — consult it before you grep:\n- graphify\n"
  );
  assert.equal(
    result,
    ".ralph/PROGRESS.md\nKnowledge index detected — consult it before you grep:\n- graphify\ndepois"
  );
});

test("renderOrientationPrompt: sem índice, o placeholder some sem deixar linha em branco", () => {
  const result = renderOrientationPrompt("antes\n{{KNOWLEDGE_INDEX_BLOCK}}\ndepois", baseCfg(), "");
  assert.equal(result, "antes\ndepois");
});

test("buildOrientationAgent: usa o modelo do config", () => {
  const agent = buildOrientationAgent("prompt de teste", { orientationModel: "sonnet" });
  assert.equal(agent.orientation.model, "sonnet");
});

test("buildOrientationAgent: sem orientationModel no config, o padrão é haiku", () => {
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

test("buildOrientationAgent: sem indexTools, a whitelist não ganha nenhuma tool de MCP", () => {
  const agent = buildOrientationAgent("prompt de teste", {});
  assert.ok(!agent.orientation.tools.some((t) => t.startsWith("mcp__")));
});

test("buildOrientationAgent: indexTools entram qualificadas como mcp__<server>__<tool>", () => {
  const agent = buildOrientationAgent("prompt de teste", {}, ["get_minimal_context_tool", "query_graph_tool"]);
  assert.ok(agent.orientation.tools.includes("mcp__code-review-graph__get_minimal_context_tool"));
  assert.ok(agent.orientation.tools.includes("mcp__code-review-graph__query_graph_tool"));
});

test("buildOrientationAgent: indexTools não substitui a whitelist base — Read/Grep/Glob/Bash continuam", () => {
  const agent = buildOrientationAgent("prompt de teste", {}, ["get_minimal_context_tool"]);
  for (const t of ["Read", "Grep", "Glob", "Bash"]) assert.ok(agent.orientation.tools.includes(t));
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

test("buildOrientationPrompt: o template real não deixa placeholder por resolver", (t) => {
  const root = tmpRepo(t);
  const prompt = buildOrientationPrompt(root, baseCfg());
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  assert.match(prompt, /\.ralph\/PROGRESS\.md/);
});

test("readOrientationTemplate: o template real só usa placeholder que a montagem resolve", () => {
  const used = [...readOrientationTemplate().matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ["KNOWLEDGE_INDEX_BLOCK", "PROGRESS_FILE"]);
});
