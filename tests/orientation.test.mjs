import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderOrientationPrompt,
  buildOrientationAgent,
  buildOrientationPrompt,
  readOrientationTemplate,
  checkOrientationContract,
} from "../src/orientation.mjs";
import { ralphHome } from "../src/paths.mjs";

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

test("buildOrientationAgent: aceita uma tag arbitrária do Ollama, sem apelido (issue #35)", () => {
  const agent = buildOrientationAgent("prompt de teste", { orientationModel: "qwen3-coder:30b-a3b-q4_K_M" });
  assert.equal(agent.orientation.model, "qwen3-coder:30b-a3b-q4_K_M");
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

// ------------------------------------------------------- checkOrientationContract --

function delegatingPrompt(block) {
  return `## 1. Orient — delegate it\n\nUse the Agent tool with \`subagent_type: "orientation"\` to figure out.\n\n${block}\n`;
}

const CONTRACT_BLOCK = ["```", "STATUS: ready | complete | blocked", "TICKET: ...", "WHY: ...", "CONTEXT: ...", "```"].join("\n");

test("checkOrientationContract: contrato idêntico passa", () => {
  const result = checkOrientationContract(delegatingPrompt(CONTRACT_BLOCK), CONTRACT_BLOCK);
  assert.equal(result.applicable, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("checkOrientationContract: rótulo removido reprova", () => {
  const orientation = ["```", "STATUS: ready | complete | blocked", "TICKET: ...", "CONTEXT: ...", "```"].join("\n");
  const result = checkOrientationContract(delegatingPrompt(CONTRACT_BLOCK), orientation);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /labels/);
});

test("checkOrientationContract: rótulo renomeado reprova", () => {
  const orientation = CONTRACT_BLOCK.replace("WHY:", "REASON:");
  const result = checkOrientationContract(delegatingPrompt(CONTRACT_BLOCK), orientation);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /labels/);
});

test("checkOrientationContract: ordem dos rótulos trocada reprova", () => {
  const orientation = ["```", "STATUS: ready | complete | blocked", "WHY: ...", "TICKET: ...", "CONTEXT: ...", "```"].join("\n");
  const result = checkOrientationContract(delegatingPrompt(CONTRACT_BLOCK), orientation);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /labels/);
});

test("checkOrientationContract: estado a mais de um lado reprova", () => {
  const orientation = CONTRACT_BLOCK.replace("ready | complete | blocked", "ready | complete | blocked | needs-info");
  const result = checkOrientationContract(delegatingPrompt(CONTRACT_BLOCK), orientation);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /states/);
});

test("checkOrientationContract: espaçamento e prosa diferentes com os mesmos rótulos passa", () => {
  const orientation = [
    "Reply with exactly this shape:",
    "",
    "```",
    "STATUS:   ready | complete | blocked",
    "TICKET: <id and title — empty when STATUS is complete or blocked>",
    "WHY:  <one paragraph>",
    "CONTEXT:   <bullet list>",
    "```",
    "",
    "If you can't fill this in, say so.",
  ].join("\n");
  const iteration = delegatingPrompt(
    ["Reports back in this shape:", "", CONTRACT_BLOCK, "", "Trust its CONTEXT instead of re-reading."].join("\n")
  );
  const result = checkOrientationContract(iteration, orientation);
  assert.equal(result.ok, true);
});

test("checkOrientationContract: prompt que não delega devolve 'não se aplica' mesmo com formatos divergentes", () => {
  const iteration = "## 1. Orient — cheaply\n\nRead only these, in this order:\n1. docs/agents/issue-tracker.md\n";
  const orientation = ["```", "STATUS: ready | complete | blocked", "TICKET: ...", "```"].join("\n");
  const result = checkOrientationContract(iteration, orientation);
  assert.deepEqual(result, { applicable: false });
});

test("checkOrientationContract: os dois prompts distribuídos com a ferramenta batem", () => {
  const iterationPrompt = readFileSync(path.join(ralphHome(), "prompts", "implement.md"), "utf8");
  const orientationTemplate = readOrientationTemplate();
  const result = checkOrientationContract(iterationPrompt, orientationTemplate);
  assert.equal(result.applicable, true);
  assert.equal(result.ok, true, result.issues.join("; "));
});
