import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt } from "../src/runner.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseCfg() {
  return {
    promptFile: ".ralph/prompt.md",
    progressFile: ".ralph/PROGRESS.md",
    completionPromise: "COMPLETE",
    blockedPromise: "BLOCKED",
    feedbackLoops: [],
  };
}

function writePrompt(root, cfg, content) {
  const file = path.join(root, cfg.promptFile);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

test("buildPrompt: repositório sem índice de conhecimento — placeholder some sem deixar linha em branco", (t) => {
  const root = tmpRepo(t);
  const cfg = baseCfg();
  writePrompt(root, cfg, "linha antes\n\n{{KNOWLEDGE_INDEX_BLOCK}}\nlinha depois\n");

  assert.equal(buildPrompt(root, cfg), "linha antes\n\nlinha depois\n");
});

test("buildPrompt: repositório com índice de conhecimento — bloco entra no lugar do placeholder", (t) => {
  const root = tmpRepo(t);
  mkdirSync(path.join(root, ".code-review-graph"), { recursive: true });
  writeFileSync(path.join(root, ".code-review-graph", "graph.db"), "");
  const cfg = baseCfg();
  writePrompt(root, cfg, "linha antes\n\n{{KNOWLEDGE_INDEX_BLOCK}}\nlinha depois\n");

  const result = buildPrompt(root, cfg);
  assert.match(result, /Knowledge index detected/);
  assert.match(result, /linha antes\n\nKnowledge/);
  assert.match(result, /\nlinha depois\n$/);
});
