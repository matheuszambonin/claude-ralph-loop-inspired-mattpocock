import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detect, render, describe, describeDegradation } from "../src/knowledge-index.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-knowledge-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function withCodeReviewGraph(root) {
  const dir = path.join(root, ".code-review-graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "graph.db"), "");
}

function withGraphify(root) {
  const dir = path.join(root, "graphify-out");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "graph.json"), "{}");
}

test("detect: repositório sem índice devolve lista vazia", (t) => {
  const root = tmpRepo(t);
  assert.deepEqual(detect(root, {}), []);
});

test("detect: reconhece code-review-graph pelo banco em .code-review-graph/", (t) => {
  const root = tmpRepo(t);
  withCodeReviewGraph(root);
  const detected = detect(root, {});
  assert.equal(detected.length, 1);
  assert.equal(detected[0].id, "code-review-graph");
});

test("detect: reconhece graphify pelo manifesto graphify-out/graph.json", (t) => {
  const root = tmpRepo(t);
  withGraphify(root);
  const detected = detect(root, {});
  assert.equal(detected.length, 1);
  assert.equal(detected[0].id, "graphify");
});

test("detect: knowledgeIndex ausente e null autodetectam do mesmo jeito", (t) => {
  const root = tmpRepo(t);
  withCodeReviewGraph(root);
  const absent = detect(root, {}).map((b) => b.id);
  const explicitNull = detect(root, { knowledgeIndex: null }).map((b) => b.id);
  assert.deepEqual(absent, ["code-review-graph"]);
  assert.deepEqual(explicitNull, ["code-review-graph"]);
});

test("detect: desligamento explícito no config vence a detecção", (t) => {
  const root = tmpRepo(t);
  withCodeReviewGraph(root);
  withGraphify(root);
  assert.deepEqual(detect(root, { knowledgeIndex: false }), []);
});

test("detect: declaração explícita usa o backend nomeado, ignorando os demais presentes", (t) => {
  const root = tmpRepo(t);
  withCodeReviewGraph(root);
  withGraphify(root);
  const detected = detect(root, { knowledgeIndex: { "code-review-graph": true } });
  assert.deepEqual(
    detected.map((b) => b.id),
    ["code-review-graph"]
  );
});

test("render: sem backend devolve bloco de prompt vazio e nenhuma configuração de MCP", () => {
  assert.deepEqual(render([], null), { promptBlock: "", mcpConfig: null, tools: [] });
});

test("render: monta mcpConfig a partir do mcpServer de cada item detectado", () => {
  const detected = [
    { id: "code-review-graph", label: "code-review-graph", path: "/repo/.code-review-graph/graph.db", updatedAt: new Date(), mcpServer: { command: "uvx", args: ["code-review-graph", "serve"] } },
  ];
  const { promptBlock, mcpConfig } = render(detected, null);
  assert.notEqual(promptBlock, "");
  assert.deepEqual(mcpConfig, { mcpServers: { "code-review-graph": { command: "uvx", args: ["code-review-graph", "serve"] } } });
});

test("render: item detectado sem mcpServer (ex.: graphify, hoje todo backend) não gera mcpConfig", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const { mcpConfig } = render(detected, null);
  assert.equal(mcpConfig, null);
});

function withCodeReviewGraphDetected() {
  return [{ id: "code-review-graph", label: "code-review-graph", path: "/repo/.code-review-graph/graph.db", updatedAt: new Date() }];
}

test("render: sem sonda (probe null), a tool de busca semântica fica fora e as outras nove entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), null);
  assert.equal(tools.length, 9);
  assert.ok(!tools.includes("semantic_search_nodes_tool"));
});

test("render: sonda sem Ollama alcançável, a tool de busca semântica fica fora e as outras nove entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), { ollamaReachable: false });
  assert.equal(tools.length, 9);
  assert.ok(!tools.includes("semantic_search_nodes_tool"));
});

test("render: sonda com Ollama alcançável, as dez tools entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), { ollamaReachable: true });
  assert.equal(tools.length, 10);
  assert.ok(tools.includes("semantic_search_nodes_tool"));
});

test("render: backend sem tools sondáveis (graphify) não gera nenhuma tool", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const { tools } = render(detected, { ollamaReachable: true });
  assert.deepEqual(tools, []);
});

test("describeDegradation: sem code-review-graph detectado devolve null", () => {
  assert.equal(describeDegradation([], { ollamaReachable: false }), null);
});

test("describeDegradation: Ollama alcançável devolve null", () => {
  assert.equal(describeDegradation(withCodeReviewGraphDetected(), { ollamaReachable: true }), null);
});

test("describeDegradation: Ollama inalcançável devolve a linha de aviso com o comando que resolve", () => {
  const line = describeDegradation(withCodeReviewGraphDetected(), { ollamaReachable: false });
  assert.match(line, /busca semântica/);
  assert.match(line, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describe: repositório sem índice devolve lista vazia", () => {
  assert.deepEqual(describe([]), []);
});

test("describe: descreve cada backend detectado", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const lines = describe(detected);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /graphify/);
  assert.match(lines[0], /\/repo\/graphify-out\/graph\.json/);
});
