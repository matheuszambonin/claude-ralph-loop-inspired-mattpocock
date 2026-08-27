import test from "node:test";
import assert from "node:assert/strict";
import {
  resolve,
  renderEnv,
  requiresAnthropicAuth,
  probe,
  probeFromSandbox,
  probeBoth,
  preload,
  describeAvailability,
  describeDegradation,
  PROBE_TIMEOUT_MS,
} from "../src/provider.mjs";
import { DEFAULTS } from "../src/config.mjs";

// `resolve` não carrega padrão próprio desde a issue #40 — quem monta o cfg
// de teste tem que refletir o que `loadConfig` de fato entrega (DEFAULTS com
// `nightProvider` mesclado um nível fundo), não um literal parcial.
function baseCfg(overrides = {}) {
  const { nightProvider, ...rest } = overrides;
  return {
    ...DEFAULTS,
    model: "sonnet",
    orientationModel: "haiku",
    ...rest,
    nightProvider: { ...DEFAULTS.nightProvider, ...nightProvider },
  };
}

test("resolve: sem night, devolve Provedor anthropic com os modelos de hoje", () => {
  const provider = resolve(baseCfg(), { night: false });
  assert.deepEqual(provider, { kind: "anthropic", baseUrl: null, model: "sonnet", orientationModel: "haiku" });
});

test("resolve: sem opts, o padrão é não-night", () => {
  assert.equal(resolve(baseCfg()).kind, "anthropic");
});

test("resolve: com night, devolve Provedor local com o modelo do nightProvider", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b" } });
  const provider = resolve(cfg, { night: true });
  assert.equal(provider.kind, "local");
  assert.equal(provider.model, "qwen3-coder:30b");
});

test("resolve: com night e orientationModel ausente, a Orientação herda o modelo da iteração", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b" } });
  assert.equal(resolve(cfg, { night: true }).orientationModel, "qwen3-coder:30b");
});

test("resolve: com night e orientationModel declarado, os dois tags divergem", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b", orientationModel: "qwen3:8b" } });
  const provider = resolve(cfg, { night: true });
  assert.equal(provider.model, "qwen3-coder:30b");
  assert.equal(provider.orientationModel, "qwen3:8b");
});

test("resolve: com night --model <tag> (já mesclado em cfg.nightProvider.model pelo withOverrides): a flag vence o config", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen2.5-coder:14b" } });
  assert.equal(resolve(cfg, { night: true }).model, "qwen2.5-coder:14b");
});

test("resolve: com night e nightProvider ausente do config, cai nos padrões sem lançar", () => {
  assert.doesNotThrow(() => resolve(baseCfg(), { night: true }));
  assert.equal(resolve(baseCfg(), { night: true }).model, DEFAULTS.nightProvider.model);
});

test("resolve: com night, endereço de loopback do config é traduzido pro host do Docker", () => {
  const cfg = baseCfg({ nightProvider: { baseUrl: "http://127.0.0.1:11434/v1" } });
  assert.equal(resolve(cfg, { night: true }).baseUrl, "http://host.docker.internal:11434/v1");
});

test("resolve: com night e keepAlive ausente do config, o padrão cobre uma noite inteira", () => {
  const provider = resolve(baseCfg({ nightProvider: { model: "qwen3-coder:30b" } }), { night: true });
  assert.equal(provider.keepAlive, DEFAULTS.nightProvider.keepAlive);
});

test("resolve: com night e keepAlive declarado no config, o valor do operador vence o padrão", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b", keepAlive: "30m" } });
  assert.equal(resolve(cfg, { night: true }).keepAlive, "30m");
});

test("resolve: com night, minContext sai junto dos outros campos do Provedor", () => {
  const cfg = baseCfg({ nightProvider: { minContext: 65536 } });
  assert.equal(resolve(cfg, { night: true }).minContext, 65536);
});

test("renderEnv: Provedor anthropic devolve objeto vazio", () => {
  assert.deepEqual(renderEnv(resolve(baseCfg(), { night: false })), {});
});

test("renderEnv: Provedor local traz base URL e um token não-vazio", () => {
  const provider = resolve(baseCfg(), { night: true });
  const env = renderEnv(provider);
  assert.equal(env.ANTHROPIC_BASE_URL, provider.baseUrl);
  assert.ok(env.ANTHROPIC_AUTH_TOKEN);
});

test("requiresAnthropicAuth: true para anthropic, false para local", () => {
  assert.equal(requiresAnthropicAuth(resolve(baseCfg(), { night: false })), true);
  assert.equal(requiresAnthropicAuth(resolve(baseCfg(), { night: true })), false);
});

// --- as três provas do Provedor (issue #32) ---

function fakeProvider(overrides = {}) {
  return {
    kind: "local",
    baseUrl: "http://fake-ollama:11434",
    model: "test-model",
    orientationModel: "test-model",
    minContext: DEFAULTS.nightProvider.minContext,
    ...overrides,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** fetchImpl injetado: `/api/tags` sempre aprova, `/v1/messages` devolve a
 *  resposta de tool_use quando o corpo declara `tools`, senão a do canário. */
function mockFetch({ toolUseResponse, canaryAnswer, canaryError }) {
  return async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    if (url.endsWith("/v1/messages")) {
      const body = JSON.parse(opts.body);
      if (body.tools) return jsonResponse(toolUseResponse);
      if (canaryError) throw canaryError;
      return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: canaryAnswer }] });
    }
    throw new Error("url inesperada: " + url);
  };
}

/** O que o `fetch` lança quando o `AbortSignal.timeout` da sonda dispara. */
function timeoutError() {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

const APPROVED_TOOL_USE = { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] };

test("probe: aprova tool_use quando a resposta traz bloco tool_use e stop_reason tool_use", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "irrelevante para este teste",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.toolUse, true);
});

test("probe: reprova tool_use quando a mesma pergunta volta como texto solto (stop_reason end_turn)", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "end_turn", content: [{ type: "text", text: "o resultado é 4" }] },
    canaryAnswer: "irrelevante para este teste",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.toolUse, false);
});

test("probe: canário aprova quando a resposta cita a senha inicial", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, true);
});

test("probe: canário reprova quando a resposta cita a senha final", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_FINAL",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
});

test("probe: porta fechada (fetchImpl lança) devolve reachable false sem propagar exceção", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.deepEqual(result, { reachable: false, toolUse: false, contextOk: false, contextTimedOut: false });
});

// --- o canário prova o minContext declarado (issue #42) ---

/** fetchImpl que simula um servidor com `contextChars` de contexto real: o
 *  começo do prompt do canário é o primeiro a cair quando o prompt excede
 *  o que o servidor aguenta, do mesmo jeito que um Ollama subdimensionado
 *  trunca o começo da conversa em silêncio. */
function serverWithContext(contextChars) {
  return async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) return jsonResponse({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] });
    const prompt = body.messages[0].content;
    const visible = prompt.length > contextChars ? prompt.slice(-contextChars) : prompt;
    const text = visible.includes("SENHA_INICIAL") ? "SENHA_INICIAL" : "SENHA_FINAL";
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text }] });
  };
}

test("probe: prompt do canário cresce com o minContext declarado", async () => {
  let smallLen = 0;
  let bigLen = 0;
  const capture = (ref) => async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) return jsonResponse({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] });
    ref.len = body.messages[0].content.length;
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "SENHA_INICIAL" }] });
  };
  const small = {};
  const big = {};
  await probe(fakeProvider({ minContext: 1000 }), { fetchImpl: capture(small) });
  await probe(fakeProvider({ minContext: 100000 }), { fetchImpl: capture(big) });
  assert.ok(big.len > small.len);
});

test("probe: servidor com contexto real menor que o minContext declarado reprova o canário", async () => {
  const provider = fakeProvider({ minContext: 100000 });
  const result = await probe(provider, { fetchImpl: serverWithContext(500) });
  assert.equal(result.contextOk, false);
});

test("probe: servidor com contexto real igual ou maior que o minContext declarado aprova o canário", async () => {
  const provider = fakeProvider({ minContext: 1000 });
  const result = await probe(provider, { fetchImpl: serverWithContext(1_000_000) });
  assert.equal(result.contextOk, true);
});

test("probe: devolve só reachable, toolUse e contextOk — nada da resposta bruta do canário", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.deepEqual(Object.keys(result).sort(), ["contextOk", "contextTimedOut", "reachable", "toolUse"]);
});

// --- lentidão não é truncamento (issue #56) ---

test("probe: canário que estoura o teto marca contextTimedOut, e o alcance continua provado", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryError: timeoutError() });
  const result = await probe(fakeProvider(), { fetchImpl });
  // As duas pernas de alcance passaram; quem falhou foi só a terceira prova.
  assert.equal(result.reachable, true);
  assert.equal(result.toolUse, true);
  assert.equal(result.contextTimedOut, true);
  // `contextOk` mantém o significado de hoje — falso nos dois casos — para
  // não quebrar quem lê só ele.
  assert.equal(result.contextOk, false);
});

test("probe: canário truncado não é timeout", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "A senha é SENHA_FINAL" });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
  assert.equal(result.contextTimedOut, false);
});

test("probe: erro que não é timeout reprova o canário sem chamá-lo de lento", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryError: new Error("status 500") });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
  assert.equal(result.contextTimedOut, false);
});

test("probe: Provedor inalcançável não reporta timeout de contexto", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextTimedOut, false);
});

test("probe: o teto do canário é o do projeto, não o herdado do fetch", async () => {
  let signal = null;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) return jsonResponse(APPROVED_TOOL_USE);
    signal = opts.signal;
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "SENHA_INICIAL" }] });
  };
  await probe(fakeProvider(), { fetchImpl });
  assert.ok(signal instanceof AbortSignal, "o pedido do canário leva o teto da sonda junto");
  assert.equal(typeof PROBE_TIMEOUT_MS, "number");
});

// --- alcance provado de dentro do sandbox (issue #46) ---

/** execImpl injetado: guarda o argv recebido e devolve o código pedido. */
function fakeExec(code = 0) {
  const calls = [];
  const execImpl = async (name, argv) => {
    calls.push({ name, argv });
    return { code, stdout: "", stderr: "" };
  };
  return { calls, execImpl };
}

test("probeFromSandbox: prova o alcance com um pedido HTTP a /api/tags, não com socket TCP direto", async () => {
  const { calls, execImpl } = fakeExec(0);
  await probeFromSandbox("sbx", fakeProvider(), { execImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "sbx");
  const argv = calls[0].argv.join(" ");
  assert.match(argv, /curl/);
  assert.match(argv, /http:\/\/fake-ollama:11434\/api\/tags/);
  assert.doesNotMatch(argv, /dev\/tcp/);
});

test("probeFromSandbox: pedido bem-sucedido aprova o alcance", async () => {
  const { execImpl } = fakeExec(0);
  assert.deepEqual(await probeFromSandbox("sbx", fakeProvider(), { execImpl }), { reachable: true });
});

test("probeFromSandbox: pedido que falha (curl não-zero) reprova o alcance", async () => {
  const { execImpl } = fakeExec(7);
  assert.deepEqual(await probeFromSandbox("sbx", fakeProvider(), { execImpl }), { reachable: false });
});

test("probeFromSandbox: baseUrl do operador vai como argumento, nunca interpolada no script do shell", async () => {
  const { calls, execImpl } = fakeExec(0);
  const provider = fakeProvider({ baseUrl: "http://evil:11434/$(touch /tmp/pwned)" });
  await probeFromSandbox("sbx", provider, { execImpl });
  const { argv } = calls[0];
  const script = argv[argv.indexOf("-lc") + 1];
  assert.doesNotMatch(script, /evil/);
  assert.doesNotMatch(script, /pwned/);
  assert.ok(argv.some((a) => a.includes("evil") && a.includes("pwned")));
});

test("probeBoth: sandbox reprovando derruba o alcance mesmo com o host aprovando", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const { execImpl } = fakeExec(1);
  const result = await probeBoth("sbx", fakeProvider(), { fetchImpl, execImpl });
  assert.equal(result.reachable, false);
});

test("probeBoth: as duas pernas aprovando devolve alcance com as outras provas do host preservadas", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const { execImpl } = fakeExec(0);
  const result = await probeBoth("sbx", fakeProvider(), { fetchImpl, execImpl });
  assert.deepEqual(result, {
    reachable: true,
    toolUse: true,
    contextOk: true,
    contextTimedOut: false,
    reachableFromHost: true,
    reachableFromSandbox: true,
  });
});

// --- as duas pernas preservadas, não só a conjunção (issue #45) ---

test("probeBoth: host aprova e sandbox reprova preserva as duas pernas além da conjunção", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const { execImpl } = fakeExec(1);
  const result = await probeBoth("sbx", fakeProvider(), { fetchImpl, execImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.reachableFromHost, true);
  assert.equal(result.reachableFromSandbox, false);
});

test("probeBoth: host reprova e sandbox aprova preserva as duas pernas", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const { execImpl } = fakeExec(0);
  const result = await probeBoth("sbx", fakeProvider(), { fetchImpl, execImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.reachableFromHost, false);
  assert.equal(result.reachableFromSandbox, true);
});

// --- aquecer o modelo antes da iteração 1 (issue #34) ---

test("preload: pede /api/generate sem prompt, com o modelo e o keep_alive do Provedor", async () => {
  let received = null;
  const fetchImpl = async (url, opts) => {
    received = { url, body: JSON.parse(opts.body) };
    return { ok: true };
  };
  const provider = fakeProvider({ keepAlive: "8h" });
  const ok = await preload(provider, { fetchImpl });
  assert.equal(ok, true);
  assert.equal(received.url, "http://fake-ollama:11434/api/generate");
  assert.deepEqual(received.body, { model: "test-model", keep_alive: "8h" });
  assert.equal("prompt" in received.body, false);
});

test("preload: resposta não-ok devolve false sem lançar", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const ok = await preload(fakeProvider(), { fetchImpl });
  assert.equal(ok, false);
});

test("preload: fetchImpl que lança (porta fechada) devolve false sem propagar exceção", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const ok = await preload(fakeProvider(), { fetchImpl });
  assert.equal(ok, false);
});

test("describeAvailability: nomeia o Provedor local e o modelo, não o Ollama", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b" } });
  const msg = describeAvailability(resolve(cfg, { night: true }));
  assert.match(msg, /Provedor local/);
  assert.match(msg, /qwen3-coder:30b/);
  assert.doesNotMatch(msg, /Ollama/i);
});

test("describeAvailability: Provedor anthropic não produz linha nenhuma", () => {
  assert.equal(describeAvailability(resolve(baseCfg(), { night: false })), null);
});

test("describeDegradation: sonda aprovada em tudo devolve null", () => {
  assert.equal(describeDegradation({ reachable: true, toolUse: true, contextOk: true }), null);
});

test("describeDegradation: inalcançável nomeia OLLAMA_HOST", () => {
  const msg = describeDegradation({ reachable: false, toolUse: false, contextOk: false });
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: sem tool_use pede pra trocar de modelo em nightProvider.model", () => {
  const msg = describeDegradation({ reachable: true, toolUse: false, contextOk: false });
  assert.match(msg, /nightProvider\.model/);
});

test("describeDegradation: canário reprovado prescreve o minContext declarado, não um número fixo", () => {
  // 65536 diverge do padrão (131072) de propósito: a constante antiga não
  // pode passar por acidente (issue #42).
  const msg = describeDegradation({ reachable: true, toolUse: true, contextOk: false }, 65536);
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH=65536/);
  assert.doesNotMatch(msg, /131072/);
});

test("describeDegradation: truncamento cita o par que precisa bater com OLLAMA_CONTEXT_LENGTH", () => {
  const msg = describeDegradation({ reachable: true, toolUse: true, contextOk: false }, 65536);
  assert.match(msg, /minContext/);
});

// --- a prova que não concluiu não é chamada de truncamento (issue #56) ---

test("describeDegradation: timeout diz que a prova não concluiu e que o Provedor pode estar íntegro", () => {
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /não concluiu/);
  assert.match(msg, /lento/);
  assert.doesNotMatch(msg, /trunca o prompt em silêncio/);
});

test("describeDegradation: timeout nomeia o par minContext + OLLAMA_CONTEXT_LENGTH e cita ollama ps", () => {
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /minContext/);
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH/);
  assert.match(msg, /ollama ps/);
});

test("describeDegradation: timeout não manda subir OLLAMA_CONTEXT_LENGTH", () => {
  // Subir o contexto piora exatamente a lentidão que causou a falha — a
  // prescrição do truncamento (`OLLAMA_CONTEXT_LENGTH=<minContext>`) não pode
  // vazar para cá.
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.doesNotMatch(msg, /OLLAMA_CONTEXT_LENGTH=65536/);
  assert.match(msg, /baixar o contexto declarado/);
});

test("describeDegradation: Provedor inalcançável recebe a prosa de alcance, nunca a do timeout", () => {
  const probeResult = {
    reachable: false,
    reachableFromHost: false,
    reachableFromSandbox: false,
    contextOk: false,
    contextTimedOut: true,
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/);
  assert.doesNotMatch(msg, /não concluiu/);
});

// --- a mensagem distingue a perna do host da perna do sandbox (issue #45) ---

test("describeDegradation: host reprova nomeia OLLAMA_HOST, mesma linha de sempre", () => {
  const probeResult = { reachable: false, reachableFromHost: false, reachableFromSandbox: false };
  const msg = describeDegradation(probeResult, undefined, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: host aprova e sandbox reprova nomeia o endereço traduzido, não manda reiniciar o serviço", () => {
  const probeResult = { reachable: false, reachableFromHost: true, reachableFromSandbox: false };
  const msg = describeDegradation(probeResult, undefined, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /http:\/\/host\.docker\.internal:11434/);
  assert.doesNotMatch(msg, /OLLAMA_HOST=0\.0\.0\.0/);
});

// --- a prescrição entrega o comando que abre a rota (issue #51) ---

test("describeDegradation: sandbox reprova entrega o comando da política de rede, com o sandbox interpolado", () => {
  const probeResult = { reachable: false, reachableFromHost: true, reachableFromSandbox: false };
  const msg = describeDegradation(probeResult, undefined, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.match(msg, /docker sandbox network proxy ralph-alvo-1abc --allow-cidr ::1\/128/);
});

test("describeDegradation: sandbox reprova não manda mais reiniciar o Docker Desktop", () => {
  // O conserto medido na issue #51 é a política de rede do sandbox; reiniciar
  // a engine não mexe nela, e o operador que obedecia pagava o ciclo inteiro
  // para continuar exatamente onde estava.
  const probeResult = { reachable: false, reachableFromHost: true, reachableFromSandbox: false };
  const msg = describeDegradation(probeResult, undefined, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.doesNotMatch(msg, /Docker Desktop/);
});

test("describeDegradation: host reprova não prescreve a política de rede — não é a rota que falhou ali", () => {
  const probeResult = { reachable: false, reachableFromHost: false, reachableFromSandbox: false };
  const msg = describeDegradation(probeResult, undefined, "http://host.docker.internal:11434", "ralph-alvo-1abc");
  assert.doesNotMatch(msg, /allow-cidr/);
});
