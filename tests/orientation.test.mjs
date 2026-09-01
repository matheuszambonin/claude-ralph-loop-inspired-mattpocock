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
  delegatesOrientation,
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

test("delegatesOrientation: separa o prompt que delega do que orienta inline (ADR-0009)", () => {
  assert.equal(delegatesOrientation('Call the `Task` tool with `subagent_type: "orientation"`.'), true);
  // `entropy.md` e `test-coverage.md` não delegam e são legítimos: sem este
  // corte, o aviso da issue #66 tocaria em toda iteração deles.
  assert.equal(delegatesOrientation("Pick the noisiest module and clean it up."), false);
});

/**
 * Issue #73: quem orienta já lê o `docs/agents/issue-tracker.md` do alvo, então
 * é o lado barato de descobrir o comando que reivindica. O "never invent one"
 * não é prosa: sem ele, o Provedor local escreve um `gh issue edit --add-label
 * in-progress` plausível contra um tracker que não tem esse rótulo.
 */
test("orientation.md: o resumo carrega o comando de claim, tirado do documento do alvo", () => {
  const orientation = readOrientationTemplate();
  assert.match(orientation, /^CLAIM: /m);
  assert.match(orientation, /straight from docs\/agents\/issue-tracker\.md/);
  assert.match(orientation, /Never\s+invent one/);
  // A fase segue read-only (ADR-0004): ela reporta o comando, não o roda.
  assert.match(orientation, /Do not claim the ticket/);
});

test("delegatesOrientation: o implement.md distribuído delega", () => {
  const implement = readFileSync(path.join(ralphHome(), "prompts", "implement.md"), "utf8");
  assert.equal(delegatesOrientation(implement), true);
});

/**
 * Issue #77: numa iteração real a Orientação rodou `gh issue close` em dois
 * tickets do alvo. O prompt só proibia `claim`, e a whitelist não alcança isso
 * — ela precisa de `Bash` para o `gh issue list`, e `close`, `comment`, `edit`
 * e `label` passam pelo mesmo binário. A linha do prompt é o que segura.
 */
test("orientation.md: a proibição de escrever no tracker nomeia os verbos, não só claim", () => {
  const paragraphs = readOrientationTemplate().split(/\n\s*\n/);
  const denial = paragraphs.find((p) => /Do not claim the ticket/.test(p));
  assert.ok(denial, "nenhum parágrafo proíbe escrever no tracker");
  for (const verb of ["claim", "close", "comment", "edit", "label"]) {
    assert.ok(denial.includes(verb), `o prompt não proíbe '${verb}'`);
  }
});

/**
 * Issue #78: a Orientação relatou como aberta e em andamento uma issue que a
 * iteração anterior fechara 43 minutos antes. O estado não veio da consulta —
 * veio do comentário de *outra* issue, que o `gh issue list --json ...,comments`
 * traz anexado na mesma leitura e que ninguém revisita quando o ticket fecha.
 *
 * A rodada de prova mostrou a segunda porta: `gh issue view 19 --comments`
 * reprovou três vezes contra este GitHub (`projectCards` deprecado), e a
 * Orientação preencheu o buraco com a mesma prosa. Consulta que falha não é
 * consulta.
 */
test("orientation.md: o estado de um ticket vem da consulta a ele, e o resumo de orientação só nomeia ticket conferido", () => {
  const paragraphs = readOrientationTemplate().split(/\n\s*\n/);
  const rule = paragraphs.find((p) => /state of a ticket/i.test(p));
  assert.ok(rule, "nenhum parágrafo diz de onde vem o estado de um ticket");
  // O caso da issue: comentário e corpo de outra issue são pista, nunca estado.
  // A polaridade entra na asserção — sem ela, um parágrafo que dissesse o
  // oposto passaria só por citar as duas palavras.
  assert.match(rule, /comment/i);
  assert.match(rule, /body/i);
  assert.match(rule, /never state/i);
  assert.match(rule, /confirms nothing/i);
  // E o resumo de orientação não pode nomear ticket que a iteração não conferiu.
  assert.match(rule, /WHY/);
  assert.match(rule, /CONTEXT/);
  assert.match(rule, /this iteration/i);
});

/**
 * Issue #81: com `gh issue list --state open --label ready-for-agent` devolvendo
 * `[]`, duas rodadas seguidas no Terraços saíram com `STATUS: ready` apontando
 * ticket de fora do frontier. Na de `ornith:9b` foi a `#12`, sem rótulo nenhum,
 * "por reconciliação"; na de `qwen3-coder:30b`, a `#21`, que é
 * `ready-for-human`. O prompt definia o frontier e oferecia `complete` e
 * `blocked` logo abaixo, mas nenhuma linha dizia que ticket de fora está fora.
 */
test("orientation.md: o frontier é fechado, e frontier vazio sai como complete ou blocked", () => {
  const paragraphs = readOrientationTemplate().split(/\n\s*\n/);
  const rule = paragraphs.find((p) => /frontier is closed/i.test(p));
  assert.ok(rule, "nenhum parágrafo diz que o frontier é fechado");
  // As duas justificativas que as rodadas inventaram, nomeadas.
  assert.match(rule, /reconcil/i);
  assert.match(rule, /decompos/i);
  // Frontier vazio é resposta: os dois estados e o `TICKET` vazio.
  assert.match(rule, /`complete`/);
  assert.match(rule, /`blocked`/);
  assert.match(rule, /empty\s+`TICKET`/);
});

/**
 * Issue #81, o outro lado: o `CLAIM:` da rodada de `qwen3-coder:30b` foi
 * `gh issue edit 21 --add-label "ready-for-agent"`, o comando que aplica o
 * rótulo que faltava. O "Never invent one" não alcançava isso — o comando é
 * plausível, e é o próprio frontier que ele fabrica.
 */
test("orientation.md: o CLAIM nunca é o comando que aplica rótulo de triagem", () => {
  const orientation = readOrientationTemplate();
  const claim = orientation.match(/^CLAIM:[\s\S]*?(?=^WHY:)/m);
  assert.ok(claim, "o bloco de contrato não descreve o campo CLAIM");
  assert.match(claim[0], /triage label/i);
});
