import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detect,
  render,
  describe,
  describeAvailability,
  describeDegradation,
  describeMcpFailure,
  describeInstallFailure,
  withInstallBlock,
  readTargetMcpConfig,
  resolveEmbeddingEnv,
  embeddingTarget,
  probe,
  encodeProbeStamp,
  decodeProbeStamp,
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
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { reachable: true });
  assert.equal(mcpConfig, null);
});

test("render: com containerRoot, monta o comando `serve` do code-review-graph com --repo e --tools", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { reachable: true }, { containerRoot: "/repo" });
  assert.deepEqual(mcpConfig.mcpServers[CRG_ID].command, CRG_ID);
  assert.deepEqual(mcpConfig.mcpServers[CRG_ID].args.slice(0, 3), ["serve", "--repo", "/repo"]);
  assert.equal(mcpConfig.mcpServers[CRG_ID].args[3], "--tools");
  assert.match(mcpConfig.mcpServers[CRG_ID].args[4], /semantic_search_nodes_tool/);
});

test("render: sem Ollama alcançável, --tools sai sem a tool de busca semântica", () => {
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { reachable: false }, { containerRoot: "/repo" });
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
    { reachable: true },
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
  const { mcpConfig } = render(withCodeReviewGraphDetected(), { reachable: true }, { containerRoot: "/repo" });
  assert.equal(mcpConfig.mcpServers[CRG_ID].env, undefined);
});

test("render: CRG_OPENAI_BASE_URL já apontado pro host do Docker (ou outro host qualquer) não muda", () => {
  const { mcpConfig } = render(
    withCodeReviewGraphDetected(),
    { reachable: true },
    { containerRoot: "/repo", embeddingEnv: { CRG_OPENAI_BASE_URL: "https://api.example.com/v1" } }
  );
  assert.equal(mcpConfig.mcpServers[CRG_ID].env.CRG_OPENAI_BASE_URL, "https://api.example.com/v1");
});

function withCodeReviewGraphDetected() {
  return [{ id: "code-review-graph", label: "code-review-graph", path: "/repo/.code-review-graph/graph.db", updatedAt: new Date() }];
}

function withMcpJson(root, contents) {
  writeFileSync(path.join(root, ".mcp.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
}

test("readTargetMcpConfig: sem .mcp.json devolve objeto vazio", (t) => {
  const root = tmpRepo(t);
  assert.deepEqual(readTargetMcpConfig(root), {});
});

test("readTargetMcpConfig: .mcp.json inválido devolve objeto vazio, sem lançar", (t) => {
  const root = tmpRepo(t);
  withMcpJson(root, "{ isso não é json");
  assert.deepEqual(readTargetMcpConfig(root), {});
});

test("readTargetMcpConfig: lê o conteúdo quando o arquivo existe e é JSON válido", (t) => {
  const root = tmpRepo(t);
  withMcpJson(root, { mcpServers: { [CRG_ID]: { env: { CRG_OPENAI_MODEL: "nomic-embed-text" } } } });
  assert.deepEqual(readTargetMcpConfig(root), {
    mcpServers: { [CRG_ID]: { env: { CRG_OPENAI_MODEL: "nomic-embed-text" } } },
  });
});

test("resolveEmbeddingEnv: sem .mcp.json e sem override devolve objeto vazio", () => {
  assert.deepEqual(resolveEmbeddingEnv({}), {});
});

test("resolveEmbeddingEnv: extrai o env do servidor code-review-graph do .mcp.json do alvo", () => {
  const targetMcpConfig = {
    mcpServers: {
      [CRG_ID]: {
        env: {
          CRG_OPENAI_API_KEY: "ollama",
          CRG_OPENAI_BASE_URL: "http://localhost:11434/v1",
          CRG_OPENAI_MODEL: "qwen3-embedding:0.6b",
          CRG_OPENAI_DIMENSION: "1024",
        },
      },
    },
  };
  assert.deepEqual(resolveEmbeddingEnv(targetMcpConfig), {
    CRG_OPENAI_API_KEY: "ollama",
    CRG_OPENAI_BASE_URL: "http://localhost:11434/v1",
    CRG_OPENAI_MODEL: "qwen3-embedding:0.6b",
    CRG_OPENAI_DIMENSION: "1024",
  });
});

test("resolveEmbeddingEnv: crgEmbeddingEnv do config vence o .mcp.json do alvo, chave a chave", () => {
  const targetMcpConfig = {
    mcpServers: { [CRG_ID]: { env: { CRG_OPENAI_MODEL: "qwen3-embedding:0.6b", CRG_OPENAI_API_KEY: "ollama" } } },
  };
  assert.deepEqual(resolveEmbeddingEnv(targetMcpConfig, { CRG_OPENAI_MODEL: "nomic-embed-text" }), {
    CRG_OPENAI_MODEL: "nomic-embed-text",
    CRG_OPENAI_API_KEY: "ollama",
  });
});

test("resolveEmbeddingEnv: CRG_TOOLS do .mcp.json do alvo nunca chega ao resultado", () => {
  const targetMcpConfig = {
    mcpServers: { [CRG_ID]: { env: { CRG_TOOLS: "semantic_search_nodes_tool,query_graph_tool", CRG_OPENAI_MODEL: "x" } } },
  };
  assert.deepEqual(resolveEmbeddingEnv(targetMcpConfig), { CRG_OPENAI_MODEL: "x" });
});

test("resolveEmbeddingEnv: .mcp.json sem o servidor code-review-graph devolve só o override", () => {
  assert.deepEqual(resolveEmbeddingEnv({ mcpServers: { outro: { env: { X: "1" } } } }, { CRG_OPENAI_MODEL: "y" }), {
    CRG_OPENAI_MODEL: "y",
  });
});

test("embeddingTarget: sem CRG_OPENAI_MODEL declarado em lugar nenhum, devolve null — nada a provar", () => {
  assert.equal(embeddingTarget({}), null);
  assert.equal(embeddingTarget({ CRG_OPENAI_BASE_URL: "https://api.openai.com/v1" }), null);
});

test("embeddingTarget: crgEmbeddingEnv vazio e sem provedor resolvido devolve null", () => {
  assert.equal(embeddingTarget(resolveEmbeddingEnv({}, {})), null);
});

test("embeddingTarget: CRG_OPENAI_BASE_URL declarado vence — mira o provedor remoto, não o Ollama", () => {
  const target = embeddingTarget({
    CRG_OPENAI_BASE_URL: "https://api.openai.com/v1",
    CRG_OPENAI_MODEL: "text-embedding-3-small",
    CRG_OPENAI_API_KEY: "sk-invalida",
  });
  assert.equal(target.baseUrl, "https://api.openai.com/v1");
  assert.equal(target.model, "text-embedding-3-small");
  assert.equal(target.apiKey, "sk-invalida");
  assert.equal(target.isOllama, false);
});

test("embeddingTarget: CRG_OPENAI_BASE_URL declarado apontando pro Ollama do host devolve isOllama true — o alvo real da #20", () => {
  const target = embeddingTarget({ CRG_OPENAI_BASE_URL: "http://localhost:11434/v1", CRG_OPENAI_MODEL: "nomic-embed-text" });
  assert.equal(target.baseUrl, "http://host.docker.internal:11434/v1");
  assert.equal(target.isOllama, true);
});

test("embeddingTarget: sem CRG_OPENAI_BASE_URL declarado, o Ollama do host é o fallback", () => {
  const target = embeddingTarget({ CRG_OPENAI_MODEL: "nomic-embed-text" });
  assert.match(target.baseUrl, /^http:\/\/host\.docker\.internal:11434\/v1$/);
  assert.equal(target.model, "nomic-embed-text");
  assert.equal(target.isOllama, true);
});

test("embeddingTarget: CRG_OPENAI_BASE_URL de loopback é traduzido pro endereço do Docker", () => {
  const target = embeddingTarget({ CRG_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", CRG_OPENAI_MODEL: "nomic-embed-text" });
  assert.equal(target.baseUrl, "http://host.docker.internal:11434/v1");
});

test("render: sem sonda (probe null), a tool de busca semântica fica fora e as outras nove entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), null);
  assert.equal(tools.length, 9);
  assert.ok(!tools.includes("semantic_search_nodes_tool"));
});

test("render: sonda sem Ollama alcançável, a tool de busca semântica fica fora e as outras nove entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), { reachable: false });
  assert.equal(tools.length, 9);
  assert.ok(!tools.includes("semantic_search_nodes_tool"));
});

test("render: sonda com Ollama alcançável, as dez tools entram", () => {
  const { tools } = render(withCodeReviewGraphDetected(), { reachable: true });
  assert.equal(tools.length, 10);
  assert.ok(tools.includes("semantic_search_nodes_tool"));
});

test("render: backend sem tools sondáveis (graphify) não gera nenhuma tool", () => {
  const detected = [{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }];
  const { tools } = render(detected, { reachable: true });
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

test("describeAvailability: sem code-review-graph detectado devolve null", () => {
  assert.equal(describeAvailability([]), null);
  assert.equal(
    describeAvailability([{ id: "graphify", label: "graphify", path: "/repo/graphify-out/graph.json", updatedAt: new Date() }]),
    null
  );
});

test("describeAvailability: fala do índice de conhecimento e do label do backend, não do processo (Ollama)", () => {
  const line = describeAvailability(withCodeReviewGraphDetected());
  assert.match(line, /índice de conhecimento/);
  assert.match(line, /\(code-review-graph\)/);
  assert.doesNotMatch(line, /Ollama/);
});

test("describeDegradation: sem code-review-graph detectado devolve null", () => {
  assert.equal(describeDegradation([], { reachable: false }), null);
});

test("describeDegradation: provedor de embeddings alcançável devolve null", () => {
  assert.equal(describeDegradation(withCodeReviewGraphDetected(), { reachable: true }), null);
});

test("describeDegradation: sem endereço sondado (probeResult.address null — sem CRG_OPENAI_MODEL declarado, ou sonda que não rodou), sem citar OLLAMA_HOST", () => {
  const line = describeDegradation(withCodeReviewGraphDetected(), { reachable: false, address: null, isOllama: false });
  assert.match(line, /busca semântica/);
  assert.match(line, /nenhum endereço sondado/);
  assert.doesNotMatch(line, /OLLAMA_HOST/);
});

test("describeDegradation: probeResult ausente (sonda ainda não rodou) usa a mesma linha genérica, sem afirmar causa", () => {
  const line = describeDegradation(withCodeReviewGraphDetected(), null);
  assert.match(line, /nenhum endereço sondado/);
  assert.doesNotMatch(line, /OLLAMA_HOST/);
});

test("describeDegradation: Ollama (fallback) reprovado nomeia o endereço sondado e cita OLLAMA_HOST=0.0.0.0", () => {
  const line = describeDegradation(withCodeReviewGraphDetected(), {
    reachable: false,
    address: "http://host.docker.internal:11434/v1",
    isOllama: true,
  });
  assert.match(line, /busca semântica/);
  assert.match(line, /host\.docker\.internal:11434\/v1/);
  assert.match(line, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: Ollama declarado no .mcp.json do alvo (não fallback) reprovado ainda cita OLLAMA_HOST=0.0.0.0 — issue #39", () => {
  const target = embeddingTarget({ CRG_OPENAI_BASE_URL: "http://localhost:11434/v1", CRG_OPENAI_MODEL: "nomic-embed-text" });
  const line = describeDegradation(withCodeReviewGraphDetected(), {
    reachable: false,
    address: target.baseUrl,
    isOllama: target.isOllama,
  });
  assert.match(line, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: provedor remoto declarado reprovado nomeia o endereço sondado, sem sugerir OLLAMA_HOST", () => {
  const line = describeDegradation(withCodeReviewGraphDetected(), {
    reachable: false,
    address: "https://api.openai.com/v1",
    isOllama: false,
  });
  assert.match(line, /busca semântica/);
  assert.match(line, /api\.openai\.com\/v1/);
  assert.doesNotMatch(line, /OLLAMA_HOST/);
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

// --- probe: executor injetável e sequência do carimbo (issue #43) ---

const EMBEDDING_ENV = { CRG_OPENAI_MODEL: "qwen3-embedding:0.6b" };

/** Chamada `bash -lc` que roda a sonda de embedding (issue #47), não a que grava o carimbo — as duas se distinguem pelo conteúdo do script, não pela contagem de argumentos. */
function isEmbeddingRequestCall(argv) {
  return argv[0] === "bash" && argv[2]?.includes("curl");
}

/**
 * Executor injetado com estado de carimbo próprio — imita o sandbox real o
 * bastante para provar a sequência (`cat` lê, `bash -lc` com `curl` sonda,
 * `bash -lc` grava) sem precisar de um sandbox de verdade. A gravação passou
 * a ir por `stdin` (`cat > arquivo`), não mais interpolada no script (issue
 * #21), então o fake grava `opts.stdin` como o novo carimbo.
 */
function fakeSandboxExec({ stamp = null, requestResult = "yes" } = {}) {
  const calls = [];
  let currentStamp = stamp;
  const execImpl = async (name, argv, opts) => {
    calls.push({ name, argv, opts });
    if (argv[0] === "cat") {
      return currentStamp === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: currentStamp, stderr: "" };
    }
    if (isEmbeddingRequestCall(argv)) {
      return { code: 0, stdout: requestResult, stderr: "" };
    }
    if (argv[0] === "bash") {
      currentStamp = opts.stdin;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`chamada inesperada: ${argv[0]}`);
  };
  return { calls, execImpl, getStamp: () => currentStamp };
}

test("probe: carimbo válido devolve o resultado gravado sem disparar pedido de embedding novo", async () => {
  const target = embeddingTarget(EMBEDDING_ENV);
  const { calls, execImpl } = fakeSandboxExec({ stamp: encodeProbeStamp(true, target) });
  const result = await probe("sbx", EMBEDDING_ENV, { execImpl });
  assert.equal(result.reachable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[0], "cat");
});

test("probe: carimbo ausente dispara a sonda e grava o resultado", async () => {
  const { calls, execImpl, getStamp } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  const result = await probe("sbx", EMBEDDING_ENV, { execImpl });
  assert.equal(result.reachable, true);
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
  assert.match(getStamp(), /^reachable\n/);
});

test("probe: carimbo com conteúdo inesperado é tratado como ausente", async () => {
  const { calls, execImpl } = fakeSandboxExec({ stamp: "garbage", requestResult: "no" });
  const result = await probe("sbx", EMBEDDING_ENV, { execImpl });
  assert.equal(result.reachable, false);
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
});

test("probe: alvo sem modelo de embedding declarado não toca sandbox nem carimbo", async () => {
  const { calls, execImpl } = fakeSandboxExec();
  const result = await probe("sbx", {}, { execImpl });
  assert.deepEqual(result, { reachable: false, address: null, isOllama: false });
  assert.equal(calls.length, 0);
});

test("probe: sonda malsucedida grava carimbo unreachable e devolve endereço/isOllama do alvo", async () => {
  const { execImpl } = fakeSandboxExec({ stamp: null, requestResult: "no" });
  const result = await probe("sbx", EMBEDDING_ENV, { execImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.isOllama, true);
  assert.match(result.address, /:11434\/v1$/);
});

// --- o carimbo guarda a identidade do que foi sondado (issue #21) ---

test("probe: trocar CRG_OPENAI_BASE_URL invalida o carimbo e re-sonda", async () => {
  const stamp = encodeProbeStamp(true, embeddingTarget(EMBEDDING_ENV));
  const changedEnv = { ...EMBEDDING_ENV, CRG_OPENAI_BASE_URL: "http://outro-provedor:8080/v1" };
  const { calls, execImpl } = fakeSandboxExec({ stamp, requestResult: "yes" });
  await probe("sbx", changedEnv, { execImpl });
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
});

test("probe: trocar CRG_OPENAI_MODEL invalida o carimbo e re-sonda", async () => {
  const stamp = encodeProbeStamp(true, embeddingTarget(EMBEDDING_ENV));
  const changedEnv = { ...EMBEDDING_ENV, CRG_OPENAI_MODEL: "outro-modelo" };
  const { calls, execImpl } = fakeSandboxExec({ stamp, requestResult: "yes" });
  await probe("sbx", changedEnv, { execImpl });
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
});

test("probe: trocar CRG_OPENAI_API_KEY invalida o carimbo e re-sonda", async () => {
  const stamp = encodeProbeStamp(true, embeddingTarget({ ...EMBEDDING_ENV, CRG_OPENAI_API_KEY: "sk-velha" }));
  const changedEnv = { ...EMBEDDING_ENV, CRG_OPENAI_API_KEY: "sk-nova" };
  const { calls, execImpl } = fakeSandboxExec({ stamp, requestResult: "yes" });
  await probe("sbx", changedEnv, { execImpl });
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
});

test("probe: declarar CRG_OPENAI_API_KEY onde antes não havia nenhuma invalida o carimbo e re-sonda", async () => {
  const stamp = encodeProbeStamp(true, embeddingTarget(EMBEDDING_ENV));
  const changedEnv = { ...EMBEDDING_ENV, CRG_OPENAI_API_KEY: "sk-nova" };
  const { calls, execImpl } = fakeSandboxExec({ stamp, requestResult: "yes" });
  await probe("sbx", changedEnv, { execImpl });
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat", "bash", "bash"]
  );
});

test("probe: configuração inalterada não re-sonda", async () => {
  const stamp = encodeProbeStamp(false, embeddingTarget(EMBEDDING_ENV));
  const { calls, execImpl } = fakeSandboxExec({ stamp });
  const result = await probe("sbx", EMBEDDING_ENV, { execImpl });
  assert.equal(result.reachable, false);
  assert.deepEqual(
    calls.map((c) => c.argv[0]),
    ["cat"]
  );
});

test("probe: a chave nunca aparece em texto no carimbo gravado", async () => {
  const env = { ...EMBEDDING_ENV, CRG_OPENAI_API_KEY: "sk-super-secreta" };
  const { execImpl, getStamp } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  await probe("sbx", env, { execImpl });
  assert.ok(!getStamp().includes("sk-super-secreta"));
});

// --- encodeProbeStamp / decodeProbeStamp (issue #21) ---

const SOME_TARGET = { baseUrl: "http://x:11434/v1", model: "algum-modelo", apiKey: "sk-1" };

test("decodeProbeStamp: identidade batendo devolve o resultado gravado", () => {
  assert.equal(decodeProbeStamp(encodeProbeStamp(true, SOME_TARGET), SOME_TARGET), true);
  assert.equal(decodeProbeStamp(encodeProbeStamp(false, SOME_TARGET), SOME_TARGET), false);
});

test("decodeProbeStamp: endereço divergente devolve null", () => {
  const raw = encodeProbeStamp(true, SOME_TARGET);
  assert.equal(decodeProbeStamp(raw, { ...SOME_TARGET, baseUrl: "http://y:11434/v1" }), null);
});

test("decodeProbeStamp: modelo divergente devolve null", () => {
  const raw = encodeProbeStamp(true, SOME_TARGET);
  assert.equal(decodeProbeStamp(raw, { ...SOME_TARGET, model: "outro-modelo" }), null);
});

test("decodeProbeStamp: chave divergente devolve null", () => {
  const raw = encodeProbeStamp(true, SOME_TARGET);
  assert.equal(decodeProbeStamp(raw, { ...SOME_TARGET, apiKey: "sk-2" }), null);
});

test("decodeProbeStamp: chave ausente nos dois lados ainda bate (provedor sem autenticação)", () => {
  const target = { ...SOME_TARGET, apiKey: "" };
  assert.equal(decodeProbeStamp(encodeProbeStamp(true, target), target), true);
});

test("decodeProbeStamp: quebra de linha a mais (CRLF de um `cat` real) não invalida um carimbo que bate", () => {
  const raw = encodeProbeStamp(true, SOME_TARGET).split("\n").join("\r\n");
  assert.equal(decodeProbeStamp(raw, SOME_TARGET), true);
});

test('decodeProbeStamp: formato antigo sem identidade (só "reachable") devolve null', () => {
  assert.equal(decodeProbeStamp("reachable", SOME_TARGET), null);
});

test("decodeProbeStamp: conteúdo irreconhecível devolve null", () => {
  assert.equal(decodeProbeStamp("garbage", SOME_TARGET), null);
});

test("encodeProbeStamp: a chave nunca aparece em texto no carimbo", () => {
  const raw = encodeProbeStamp(true, { ...SOME_TARGET, apiKey: "sk-super-secreta" });
  assert.ok(!raw.includes("sk-super-secreta"));
});

// --- sonda usa curl, não o fetch do Node, para respeitar o proxy do docker sandbox (issue #47) ---

test("probe: pede embedding com curl, não com o fetch do Node", async () => {
  const { calls, execImpl } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  await probe("sbx", EMBEDDING_ENV, { execImpl });
  const request = calls.find((c) => isEmbeddingRequestCall(c.argv));
  const script = request.argv[2];
  assert.match(script, /curl/);
  assert.doesNotMatch(script, /fetch\(/);
});

test("probe: a chave do provedor de embeddings vai por stdin, nunca aparece no argv do processo bash", async () => {
  const { calls, execImpl } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  const env = { ...EMBEDDING_ENV, CRG_OPENAI_API_KEY: "sk-super-secreta" };
  await probe("sbx", env, { execImpl });
  const request = calls.find((c) => isEmbeddingRequestCall(c.argv));
  assert.equal(request.opts.stdin, "sk-super-secreta");
  assert.ok(!request.argv.some((a) => a.includes("sk-super-secreta")));
});

test("probe: o script passa a chave ao curl via -H @-, nunca como argumento literal do curl", async () => {
  // `-H "authorization: Bearer $apikey"` no argv do próprio `curl` reabriria a
  // mesma exposição um processo abaixo (`ps aux` do processo `curl`) — o
  // script precisa entregar o header pelo stdin do `curl`, não pelo argv dele.
  const { calls, execImpl } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  await probe("sbx", EMBEDDING_ENV, { execImpl });
  const request = calls.find((c) => isEmbeddingRequestCall(c.argv));
  const script = request.argv[2];
  assert.match(script, /-H @-/);
  assert.doesNotMatch(script, /-H "authorization/);
});

test("probe: url e corpo do pedido vão como argumentos posicionais, nunca interpolados no script", async () => {
  const { calls, execImpl } = fakeSandboxExec({ stamp: null, requestResult: "yes" });
  const env = { ...EMBEDDING_ENV, CRG_OPENAI_BASE_URL: "http://evil:11434/$(touch /tmp/pwned)" };
  await probe("sbx", env, { execImpl });
  const request = calls.find((c) => isEmbeddingRequestCall(c.argv));
  const script = request.argv[2];
  assert.doesNotMatch(script, /evil/);
  assert.doesNotMatch(script, /pwned/);
  assert.ok(request.argv.some((a) => a.includes("evil") && a.includes("pwned")));
});
