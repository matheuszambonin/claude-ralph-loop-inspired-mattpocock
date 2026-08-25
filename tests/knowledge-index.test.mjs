import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detect,
  render,
  describe,
  describeDegradation,
  describeMcpFailure,
  describeInstallFailure,
  withInstallBlock,
  CRG_ID,
} from "../src/knowledge-index.mjs";

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

test("render: sem containerRoot, nenhum mcpConfig — não há --repo para montar", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { ollamaReachable: true });
  assert.equal(mcpConfig, null);
});

test("render: com containerRoot, monta o comando `serve` do code-review-graph com --repo e --tools", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { ollamaReachable: true }, { containerRoot: "/repo" });
  assert.deepEqual(mcpConfig.mcpServers[CRG_ID].command, CRG_ID);
  assert.deepEqual(mcpConfig.mcpServers[CRG_ID].args.slice(0, 3), ["serve", "--repo", "/repo"]);
  assert.equal(mcpConfig.mcpServers[CRG_ID].args[3], "--tools");
  assert.match(mcpConfig.mcpServers[CRG_ID].args[4], /semantic_search_nodes_tool/);
});

test("render: sem Ollama alcançável, --tools sai sem a tool de busca semântica", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { ollamaReachable: false }, { containerRoot: "/repo" });
  assert.doesNotMatch(mcpConfig.mcpServers[CRG_ID].args[4], /semantic_search_nodes_tool/);
});

test("render: item detectado sem servidor MCP (graphify, consultado em prosa) não gera mcpConfig", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const { mcpConfig } = render(detected, null, { containerRoot: "/repo" });
  assert.equal(mcpConfig, null);
});

test("render: embeddingEnv passa como está, exceto CRG_OPENAI_BASE_URL de loopback traduzido pro host do Docker", () => {
  const { mcpConfig } = render(
    withCodeReviewGraphDetected(),
    { ollamaReachable: true },
    {
      containerRoot: "/repo",
      embeddingEnv: {
        CRG_OPENAI_API_KEY: "ollama",
        CRG_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        CRG_OPENAI_MODEL: "nomic-embed-text",
      },
    }
  );
  assert.deepEqual(mcpConfig.mcpServers[CRG_ID].env, {
    CRG_OPENAI_API_KEY: "ollama",
    CRG_OPENAI_BASE_URL: "http://host.docker.internal:11434/v1",
    CRG_OPENAI_MODEL: "nomic-embed-text",
  });
});

test("render: embeddingEnv ausente não acrescenta env nenhum ao servidor MCP", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { ollamaReachable: true }, { containerRoot: "/repo" });
  assert.equal(mcpConfig.mcpServers[CRG_ID].env, undefined);
});

test("render: CRG_OPENAI_BASE_URL já apontado pro host do Docker (ou outro host qualquer) não muda", () => {
  const { mcpConfig } = render(
    withCodeReviewGraphDetected(),
    { ollamaReachable: true },
    { containerRoot: "/repo", embeddingEnv: { CRG_OPENAI_BASE_URL: "https://api.example.com/v1" } }
  );
  assert.equal(mcpConfig.mcpServers[CRG_ID].env.CRG_OPENAI_BASE_URL, "https://api.example.com/v1");
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

test("render: bloco de prompt cabe em poucas linhas, mesmo com os dois backends detectados", () => {
  const detected = [
    ...withCodeReviewGraphDetected(),
    { id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() },
  ];
  const { promptBlock } = render(detected, null);
  assert.ok(promptBlock.split("\n").length <= 6, promptBlock);
});

test("render: backend chaveado por caminho absoluto do host (code-review-graph) carrega a regra de tradução no bloco", () => {
  const { promptBlock } = render(withCodeReviewGraphDetected(), null);
  assert.match(promptBlock, /host.*sandbox/i);
});

test("render: backend em prosa (graphify) aponta a seção de navegação, não o documento inteiro", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const { promptBlock } = render(detected, null);
  assert.match(promptBlock, /navigation section/);
});

test("render: um backend só produz o mesmo promptBlock de antes da issue #18", () => {
  const { promptBlock } = render(withCodeReviewGraphDetected(), null);
  assert.equal(
    promptBlock,
    "Knowledge index detected — consult it before you grep:\n" +
      "- code-review-graph (/repo/.code-review-graph/graph.db): paths this tool returns are host-formatted " +
      "(`C:\\...`); translate to the sandbox by lowercasing the drive letter and turning backslashes into " +
      "slashes (`/c/...`)\n"
  );
});

test("render: dois backends detectados, o bloco diz qual consultar primeiro e por quê", () => {
  const detected = [
    ...withCodeReviewGraphDetected(),
    { id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() },
  ];
  const { promptBlock } = render(detected, null);
  assert.match(promptBlock, /Start with code-review-graph/);
  assert.match(promptBlock, /cheaper/);
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

test("describeMcpFailure: repositório sem índice devolve null mesmo com servidor falho", () => {
  assert.equal(describeMcpFailure([], [{ name: "code-review-graph", status: "failed" }]), null);
});

test("describeMcpFailure: índice detectado mas sessão sem mcp_servers (campo ausente) devolve null", () => {
  assert.equal(describeMcpFailure(withCodeReviewGraphDetected(), null), null);
  assert.equal(describeMcpFailure(withCodeReviewGraphDetected(), undefined), null);
});

test("describeMcpFailure: nenhum servidor da sessão casa com o id do backend detectado devolve null", () => {
  const line = describeMcpFailure(withCodeReviewGraphDetected(), [{ name: "outro-servidor", status: "failed" }]);
  assert.equal(line, null);
});

test("describeMcpFailure: servidor casado e conectado devolve null", () => {
  const line = describeMcpFailure(withCodeReviewGraphDetected(), [{ name: "code-review-graph", status: "connected" }]);
  assert.equal(line, null);
});

test("describeMcpFailure: servidor casado e falho devolve aviso com a consequência em palavras e o comando que investiga", () => {
  const line = describeMcpFailure(withCodeReviewGraphDetected(), [{ name: "code-review-graph", status: "failed" }]);
  assert.match(line, /code-review-graph/);
  assert.match(line, /varrer arquivo/);
  assert.match(line, /ralph doctor/);
});

test("describeInstallFailure: sem resultado de sonda (repositório sem backend que precise de binário) devolve null", () => {
  assert.equal(describeInstallFailure(null), null);
});

test("describeInstallFailure: binário instalado devolve null", () => {
  assert.equal(describeInstallFailure({ installed: true }), null);
});

test("describeInstallFailure: binário ausente devolve aviso com o comando que conserta", () => {
  const line = describeInstallFailure({ installed: false });
  assert.match(line, /code-review-graph/);
  assert.match(line, /ralph bootstrap --force/);
});

const SETUP_TEMPLATE = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  '# Python',
  '# python3 -m pip install --quiet --break-system-packages -e ".[dev]"',
  "",
  'echo "setup: nada a fazer (edite .ralph/setup.sh)"',
  "",
].join("\n");

test("withInstallBlock: repositório sem índice devolve o setup.sh idêntico", () => {
  assert.equal(withInstallBlock(SETUP_TEMPLATE, []), SETUP_TEMPLATE);
});

test("withInstallBlock: graphify sozinho (sem binário a instalar) devolve o setup.sh idêntico", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  assert.equal(withInstallBlock(SETUP_TEMPLATE, detected), SETUP_TEMPLATE);
});

test("withInstallBlock: code-review-graph detectado insere o passo de instalação", () => {
  const out = withInstallBlock(SETUP_TEMPLATE, withCodeReviewGraphDetected());
  assert.match(out, /pip install --quiet --break-system-packages code-review-graph/);
  assert.match(out, /3, 10/);
  assert.ok(out.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n"));
  assert.match(out, /echo "setup: nada a fazer/);
});

test("withInstallBlock: aplicar duas vezes não duplica o bloco", () => {
  const once = withInstallBlock(SETUP_TEMPLATE, withCodeReviewGraphDetected());
  const twice = withInstallBlock(once, withCodeReviewGraphDetected());
  assert.equal(twice, once);
  assert.equal(once.match(/code-review-graph precisa do binário/g).length, 1);
});

test("withInstallBlock: preserva o conteúdo do usuário fora do bloco gerado", () => {
  const custom = SETUP_TEMPLATE.replace(
    '# python3 -m pip install --quiet --break-system-packages -e ".[dev]"',
    'python3 -m pip install --quiet --break-system-packages -e ".[dev]"'
  );
  const out = withInstallBlock(custom, withCodeReviewGraphDetected());
  assert.match(out, /-e "\.\[dev\]"/);
  assert.match(out, /pip install --quiet --break-system-packages code-review-graph/);
});
