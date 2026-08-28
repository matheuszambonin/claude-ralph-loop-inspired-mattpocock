import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt, renderPrompt, describeIterationTimeout } from "../src/runner.mjs";
import { buildOrientationPrompt } from "../src/orientation.mjs";
import { DEFAULTS } from "../src/config.mjs";

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

test("renderPrompt: resolve PROGRESS_FILE, as promises e os feedback loops", () => {
  const cfg = { ...baseCfg(), feedbackLoops: ["npm test", "npm run lint"] };
  const result = renderPrompt(
    "{{PROGRESS_FILE}} / {{COMPLETION_PROMISE}} / {{BLOCKED_PROMISE}}\n{{FEEDBACK_LOOPS}}",
    cfg
  );
  assert.equal(
    result,
    ".ralph/PROGRESS.md / COMPLETE / BLOCKED\n1. `npm test` — must pass\n2. `npm run lint` — must pass"
  );
});

test("renderPrompt: sem feedbackLoops configurado, cai no fallback de descoberta", () => {
  const result = renderPrompt("{{FEEDBACK_LOOPS}}", baseCfg());
  assert.match(result, /Discover this repo's checks/);
});

test("renderPrompt: config do usuário sem blockedPromise cai no padrão de DEFAULTS", () => {
  const userCfg = baseCfg();
  delete userCfg.blockedPromise;
  const cfg = { ...DEFAULTS, ...userCfg };
  assert.equal(renderPrompt("{{BLOCKED_PROMISE}}", cfg), "BLOCKED");
});

test("buildPrompt: lê o prompt do repo alvo e resolve os placeholders", (t) => {
  const root = tmpRepo(t);
  const cfg = baseCfg();
  writePrompt(root, cfg, "ticket: {{PROGRESS_FILE}}");

  assert.equal(buildPrompt(root, cfg), "ticket: .ralph/PROGRESS.md");
});

test("buildPrompt: prompt ausente falha dizendo o comando que conserta", (t) => {
  const root = tmpRepo(t);
  assert.throws(() => buildPrompt(root, baseCfg()), /ralph init/);
});

test("issue #10: repositório com índice — o bloco vai para o prompt do subagente, não para o da iteração", (t) => {
  const root = tmpRepo(t);
  mkdirSync(path.join(root, ".code-review-graph"), { recursive: true });
  writeFileSync(path.join(root, ".code-review-graph", "graph.db"), "");
  const cfg = baseCfg();
  writePrompt(root, cfg, "prompt da iteração, sem placeholder de índice");

  assert.doesNotMatch(buildPrompt(root, cfg), /Knowledge index detected/);
  assert.match(buildOrientationPrompt(root, cfg), /Knowledge index detected/);
});

// Issue #67: o estouro do teto é a única falha de iteração cujo log não tem
// linha de erro nenhuma — o processo morreu no meio de uma frase. A mensagem
// é o que sobra, então ela precisa carregar o log e o campo que afrouxa.
test("describeIterationTimeout: nomeia o log da iteração e o campo do config que afrouxa o teto", () => {
  const msg = describeIterationTimeout({
    iteration: 3,
    seconds: 3600,
    logPath: ".ralph/logs/2026-08-28-iter-03.jsonl",
  });
  assert.match(msg, /iteração 3/);
  assert.match(msg, /3600/);
  assert.match(msg, /\.ralph\/logs\/2026-08-28-iter-03\.jsonl/);
  assert.match(msg, /iterationTimeoutSeconds/);
});
