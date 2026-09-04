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
  canaryFiller,
  describeAvailability,
  describeProbeStart,
  describeDegradation,
  httpJson,
} from "../src/provider.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { createServer } from "node:http";

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

// O teto do canário é do operador (issue #57): mesmo caminho de `minContext`,
// do config ao Provedor resolvido.
test("resolve: com night, o teto do canário sai junto dos outros campos do Provedor", () => {
  const cfg = baseCfg({ nightProvider: { probeTimeoutSeconds: 1800 } });
  assert.equal(resolve(cfg, { night: true }).probeTimeoutSeconds, 1800);
});

test("resolve: com night e probeTimeoutSeconds ausente do config, o padrão generoso chega sozinho", () => {
  const provider = resolve(baseCfg({ nightProvider: { model: "qwen3-coder:30b" } }), { night: true });
  assert.equal(provider.probeTimeoutSeconds, DEFAULTS.nightProvider.probeTimeoutSeconds);
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
    probeTimeoutSeconds: DEFAULTS.nightProvider.probeTimeoutSeconds,
    ...overrides,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** Envelope do chat que todo pedido carrega (issue #55): o `input_tokens` conta
 *  o template do modelo junto com o filler. Medido contra `devstral:24b` no
 *  Ollama 0.33.0, ele são 1226 tokens — um system prompt inteiro, não os 10 a
 *  20 que a triagem supunha. */
const MOCK_ENVELOPE_TOKENS = 1226;

/** Contagem que um Provedor de razão `charsPerToken` devolveria para um prompt
 *  de `chars` caracteres. */
function usageFor(chars, charsPerToken, envelope = MOCK_ENVELOPE_TOKENS) {
  return { input_tokens: Math.round(chars / charsPerToken) + envelope };
}

/** fetchImpl injetado: `/api/tags` sempre aprova, e `/v1/messages` separa as
 *  pernas pelo corpo — `tools` é a prova de tool_use, `max_tokens: 1` são os
 *  dois pedidos da calibragem, o resto é o canário. Pelo corpo e não pela
 *  ordem de chamada, que amarraria o teste à sequência interna de `probe()`.
 *
 *  `calibrationRatio` é a razão que o Provedor simulado tem; `null` faz a
 *  resposta voltar sem `usage`, que é o Provedor em que a calibragem não tem o
 *  que ler. */
function mockFetch({
  toolUseResponse,
  canaryAnswer,
  canaryError,
  canaryResponse,
  calibrationRatio = 4,
  calibrationEnvelope = MOCK_ENVELOPE_TOKENS,
  calibrationError,
}) {
  return async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    if (url.endsWith("/v1/messages")) {
      const body = JSON.parse(opts.body);
      if (body.tools) return jsonResponse(toolUseResponse);
      const prompt = body.messages[0].content;
      if (body.max_tokens === 1) {
        if (calibrationError) throw calibrationError;
        const usage =
          calibrationRatio === null ? undefined : usageFor(prompt.length, calibrationRatio, calibrationEnvelope);
        return jsonResponse({ stop_reason: "max_tokens", content: [], usage });
      }
      if (canaryError) throw canaryError;
      const usage =
        calibrationRatio === null ? undefined : usageFor(prompt.length, calibrationRatio, calibrationEnvelope);
      if (canaryResponse) return jsonResponse({ usage, ...canaryResponse });
      return jsonResponse({
        stop_reason: "end_turn",
        content: [{ type: "text", text: canaryAnswer }],
        usage,
      });
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
  assert.deepEqual(result, {
    reachable: false,
    toolUse: false,
    contextOk: false,
    contextTimedOut: false,
    outputExhausted: false,
    contextTokens: null,
    redirect: null,
  });
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
    if (body.max_tokens === 1) return jsonResponse({ stop_reason: "max_tokens", content: [] });
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

test("probe: devolve só os vereditos das provas — nada da resposta bruta do canário", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer" }] },
    canaryAnswer: "A senha é SENHA_INICIAL",
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.deepEqual(Object.keys(result).sort(), [
    "contextOk",
    "contextTimedOut",
    "contextTokens",
    "outputExhausted",
    "reachable",
    "redirect",
    "toolUse",
  ]);
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
    outputExhausted: false,
    contextTokens: result.contextTokens,
    redirect: null,
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

// O aquecimento sai do teto herdado (issue #60). Ele ficou no `fetch` global
// quando a issue #57 trocou o cliente das três provas, e um modelo de 30B pode
// passar dos 300s do undici para carregar — na máquina que declarou 900s, o
// aviso "aquecimento falhou" mentia sobre um aquecimento que ia bem. O teto
// agora é o mesmo número que o operador declarou para as provas, e o cliente é
// o `httpJson`, que já não conhece os 300s. Aqui a fração de segundo faz o
// papel dos minutos da produção: o que se prova é de onde vem o número.
test("preload: aquecimento lento dentro do teto declarado conclui, sem virar aviso de falha", async (t) => {
  const url = await slowServer(t, { bodyDelay: 200 });
  const ok = await preload(fakeProvider({ baseUrl: url, probeTimeoutSeconds: 10 }));
  assert.equal(ok, true);
});

test("preload: aquecimento que estoura o teto declarado devolve false sem lançar", async (t) => {
  const url = await slowServer(t, { bodyDelay: 400 });
  const ok = await preload(fakeProvider({ baseUrl: url, probeTimeoutSeconds: 0.08 }));
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

test("describeProbeStart: anuncia a sonda do Provedor local e o teto vigente", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b" } });
  const msg = describeProbeStart(resolve(cfg, { night: true }));
  assert.match(msg, /Provedor local/);
  assert.match(msg, /qwen3-coder:30b/);
  assert.match(msg, new RegExp(`${DEFAULTS.nightProvider.probeTimeoutSeconds}s`));
});

test("describeProbeStart: o teto citado é o que o operador declarou, não o padrão", () => {
  const cfg = baseCfg({ nightProvider: { probeTimeoutSeconds: 2400 } });
  const msg = describeProbeStart(resolve(cfg, { night: true }));
  assert.match(msg, /2400s/);
  assert.doesNotMatch(msg, new RegExp(`${DEFAULTS.nightProvider.probeTimeoutSeconds}s`));
});

test("describeProbeStart: Provedor anthropic não produz linha nenhuma", () => {
  assert.equal(describeProbeStart(resolve(baseCfg(), { night: false })), null);
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
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /não concluiu/);
  assert.match(msg, /lento/);
  assert.doesNotMatch(msg, /trunca o prompt em silêncio/);
});

test("describeDegradation: timeout nomeia o par minContext + OLLAMA_CONTEXT_LENGTH e cita ollama ps", () => {
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /minContext/);
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH/);
  assert.match(msg, /ollama ps/);
});

test("describeDegradation: timeout não manda subir OLLAMA_CONTEXT_LENGTH", () => {
  // Subir o contexto piora exatamente a lentidão que causou a falha — a
  // prescrição do truncamento (`OLLAMA_CONTEXT_LENGTH=<minContext>`) não pode
  // vazar para cá.
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
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
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
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


// --- o teto é do operador, e vale acima de 300s (issue #57) ---

test("describeDegradation: timeout diz contra que número a prova perdeu e onde mudá-lo", () => {
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /900s/);
  assert.match(msg, /nightProvider\.probeTimeoutSeconds/);
});

test("describeDegradation: o número da prosa é o teto vigente, não uma constante fixa", () => {
  const probeResult = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 1800);
  assert.match(msg, /1800s/);
  assert.doesNotMatch(msg, /900s/);
});

// --- a prova que não concluiu não é prova sobre o modelo (issue #59) ---

test("describeDegradation: tool_use reprovado com timeout é relatado como a prova que não concluiu", () => {
  const probeResult = { reachable: true, toolUse: false, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /não concluiu/);
  assert.match(msg, /900s/);
  assert.match(msg, /nightProvider\.probeTimeoutSeconds/);
});

test("describeDegradation: tool_use reprovado com timeout não manda trocar o modelo por incapaz", () => {
  // O conserto caro que este ticket existe para não prescrever: um `ollama
  // pull` de dezenas de GB por uma falha que era do teto, não do modelo. A
  // prosa do timeout cita nightProvider.model por outro motivo — um modelo que
  // caiba na GPU —, então o que não pode vazar é o diagnóstico de incapacidade.
  const probeResult = { reachable: true, toolUse: false, contextOk: false, contextTimedOut: true };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.doesNotMatch(msg, /não emite tool_use estruturado/);
  assert.doesNotMatch(msg, /escreve a chamada de ferramenta como texto/);
});

test("describeDegradation: tool_use reprovado sem timeout continua mandando trocar nightProvider.model", () => {
  const probeResult = { reachable: true, toolUse: false, contextOk: false, contextTimedOut: false };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /nightProvider\.model/);
  assert.match(msg, /escreve a chamada de ferramenta como texto/);
  assert.doesNotMatch(msg, /não concluiu/);
});

test("describeDegradation: inalcançável com tool_use reprovado e timeout continua recebendo a prosa de alcance", () => {
  const probeResult = {
    reachable: false,
    reachableFromHost: false,
    reachableFromSandbox: false,
    toolUse: false,
    contextOk: false,
    contextTimedOut: true,
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/);
  assert.doesNotMatch(msg, /não concluiu/);
  assert.doesNotMatch(msg, /nightProvider\.model/);
});

// --- o cliente da biblioteca padrão, que aceita teto arbitrário (issue #57) ---
//
// O `fetch` global morre aos 300s pelo `headersTimeout` do undici, que a API
// pública do Node não expõe: um teto declarado acima disso seria mentira. Os
// testes abaixo medem em milissegundos o que a produção mede em minutos — a
// propriedade é a mesma, o teto ser o que a sonda pediu e cobrir o corpo.

/** Servidor que atrasa os cabeçalhos por `headDelay` e o resto do corpo por
 *  `bodyDelay`, para separar "demorou a responder" de "demorou a terminar". */
function slowServer(t, { headDelay = 0, bodyDelay = 0, body = '{"ok":true}' } = {}) {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(body.slice(0, 1));
      setTimeout(() => res.end(body.slice(1)), bodyDelay);
    }, headDelay);
  });
  t.after(() => server.close());
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`));
  });
}

test("httpJson: devolve a forma do fetch — ok, status e json() do corpo inteiro", async (t) => {
  const url = await slowServer(t, { body: JSON.stringify({ stop_reason: "end_turn" }) });
  const res = await httpJson(url);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stop_reason: "end_turn" });
});

test("httpJson: status não-2xx volta com ok falso, sem lançar", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(500).end("{}");
  });
  t.after(() => server.close());
  const url = await new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`)),
  );
  const res = await httpJson(url);
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test("httpJson: o teto cobre o corpo, não só os cabeçalhos — é o corpo que traz a resposta do canário", async (t) => {
  const url = await slowServer(t, { bodyDelay: 400 });
  await assert.rejects(
    () => httpJson(url, { signal: AbortSignal.timeout(80) }),
    (err) => err.name === "TimeoutError",
  );
});

test("httpJson: resposta que chega dentro do teto não é abortada", async (t) => {
  const url = await slowServer(t, { headDelay: 30, bodyDelay: 30 });
  const res = await httpJson(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.ok, true);
});

test("probe: o canário morre no teto que o Provedor declarou, não num teto herdado", async (t) => {
  const url = await slowServer(t, { bodyDelay: 400 });
  // Fração de segundo aqui é o mesmo campo que em produção vale 900: o que se
  // prova é que o número do Provedor é o que manda.
  const provider = fakeProvider({ baseUrl: url, minContext: 100, probeTimeoutSeconds: 0.08 });
  const result = await probe(provider);
  assert.equal(result.reachable, true);
  assert.equal(result.contextTimedOut, true);
  assert.equal(result.contextOk, false);
});

test("probe: com teto folgado, o mesmo Provedor lento conclui a prova", async (t) => {
  const url = await slowServer(t, {
    bodyDelay: 200,
    body: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "SENHA_INICIAL" }] }),
  });
  const provider = fakeProvider({ baseUrl: url, minContext: 100, probeTimeoutSeconds: 10 });
  const result = await probe(provider);
  assert.equal(result.contextTimedOut, false);
  assert.equal(result.contextOk, true);
});

// --- a sonda diz que foi redirect, em vez de culpar o modelo (issue #61) ---
//
// O cliente da issue #57 não segue 3xx, e essa é a decisão registrada no
// ticket. Contra o Ollama de loopback do caminho feliz isso é invisível;
// contra um `baseUrl` mediado por proxy, a sonda passa a ver uma resposta
// não-2xx onde antes via o corpo final. O que estes testes prendem é o
// diagnóstico, não o comportamento: um problema de endereço não pode sair
// como prosa sobre o modelo.

/** Servidor que responde 3xx em toda rota, como um proxy que reescreve o
 *  endereço do Provedor faria. */
function redirectingServer(t, status, location) {
  const server = createServer((req, res) => {
    res.writeHead(status, { location }).end();
  });
  t.after(() => server.close());
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`));
  });
}

test("httpJson: 3xx volta com ok falso e o Location do cabeçalho, sem seguir o redirect", async (t) => {
  const url = await redirectingServer(t, 301, "https://ollama.example/api/tags");
  const res = await httpJson(url);
  assert.equal(res.ok, false);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, "https://ollama.example/api/tags");
});

test("probe: /api/tags respondendo 3xx reprova o alcance e registra o redirect com o destino", async () => {
  const fetchImpl = async () => ({ ok: false, status: 302, headers: { location: "http://proxy:8080/api/tags" } });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.reachable, false);
  assert.deepEqual(result.redirect, { status: 302, location: "http://proxy:8080/api/tags" });
});

test("probe: /v1/messages respondendo 3xx registra o redirect em vez de só reprovar as provas", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    return { ok: false, status: 308, headers: { location: "https://ollama.example/v1/messages" } };
  };
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.toolUse, false);
  assert.deepEqual(result.redirect, { status: 308, location: "https://ollama.example/v1/messages" });
});

test("probe: redirect sem cabeçalho Location ainda é registrado como redirect", async () => {
  const fetchImpl = async () => ({ ok: false, status: 303, headers: {} });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.deepEqual(result.redirect, { status: 303, location: null });
});

test("probe: resposta não-2xx que não é redirect não vira redirect", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: {} });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.redirect, null);
});

test("probe: 304 não é redirect — ele não manda a sonda a endereço nenhum", async () => {
  const fetchImpl = async () => ({ ok: false, status: 304, headers: {} });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.redirect, null);
});

test("probe: sonda que passa em tudo não registra redirect nenhum", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "A senha é SENHA_INICIAL" });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.redirect, null);
});

test("describeDegradation: redirect nomeia o status, o destino e nightProvider.baseUrl", () => {
  const probeResult = {
    reachable: false,
    reachableFromHost: false,
    reachableFromSandbox: true,
    toolUse: false,
    contextOk: false,
    contextTimedOut: false,
    redirect: { status: 307, location: "https://ollama.example/v1" },
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /307/);
  assert.match(msg, /redirect/);
  assert.match(msg, /https:\/\/ollama\.example\/v1/);
  assert.match(msg, /nightProvider\.baseUrl/);
});

test("describeDegradation: redirect não culpa o modelo, o contexto nem a lentidão", () => {
  const probeResult = {
    reachable: true,
    toolUse: false,
    contextOk: false,
    contextTimedOut: true,
    redirect: { status: 302, location: "http://proxy:8080/v1" },
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.doesNotMatch(msg, /nightProvider\.model/);
  assert.doesNotMatch(msg, /OLLAMA_CONTEXT_LENGTH/);
  assert.doesNotMatch(msg, /não concluiu/);
  assert.doesNotMatch(msg, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: redirect sem Location diz que o cabeçalho não veio, e prescreve o mesmo conserto", () => {
  const probeResult = {
    reachable: false,
    reachableFromHost: false,
    reachableFromSandbox: false,
    redirect: { status: 301, location: null },
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /301/);
  assert.match(msg, /Location/);
  assert.match(msg, /nightProvider\.baseUrl/);
});

test("describeDegradation: sem redirect, as reprovações de sempre seguem intactas", () => {
  const probeResult = { reachable: true, toolUse: false, contextOk: false, contextTimedOut: false, redirect: null };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /escreve a chamada de ferramenta como texto/);
});

// --- o modelo que pensa antes de responder (issue #64) ---
//
// `thinking` é a norma nos lançamentos recentes, e a medição do ticket mostra
// o raciocínio consumindo o orçamento de saída inteiro: o texto voltava vazio
// e o Provedor íntegro era acusado de truncar o prompt. O que estes testes
// prendem é o critério continuar lendo só os blocos de texto, e a resposta
// vazia por teto de saída ter prosa própria.

test("probe: o bloco de raciocínio não conta como resposta — citar a senha do fim ao pensar não reprova", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryResponse: {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "O texto começa em SENHA_INICIAL e termina em SENHA_FINAL." },
        { type: "text", text: "SENHA_INICIAL" },
      ],
    },
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, true);
  assert.equal(result.outputExhausted, false);
});

test("probe: raciocínio que cita a senha do começo, sem texto, não aprova o canário", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryResponse: {
      stop_reason: "max_tokens",
      content: [{ type: "thinking", thinking: "A senha do início é SENHA_INICIAL." }],
    },
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
  assert.equal(result.outputExhausted, true);
});

test("probe: resposta vazia por max_tokens não é truncamento nem lentidão", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryResponse: { stop_reason: "max_tokens", content: [{ type: "text", text: "" }] },
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.outputExhausted, true);
  assert.equal(result.contextTimedOut, false);
  assert.equal(result.contextOk, false);
});

test("probe: texto que cita a senha do fim reprova por truncamento mesmo com stop_reason max_tokens", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryResponse: { stop_reason: "max_tokens", content: [{ type: "text", text: "A senha é SENHA_FINAL" }] },
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
  assert.equal(result.outputExhausted, false);
});

test("probe: resposta vazia sem max_tokens não vira esgotamento de orçamento", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "" });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.outputExhausted, false);
  assert.equal(result.contextOk, false);
});

test("probe: canário morto no teto de tempo não é reportado como orçamento de saída", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryError: timeoutError() });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextTimedOut, true);
  assert.equal(result.outputExhausted, false);
});

test("probe: Provedor inalcançável não reporta esgotamento de orçamento", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal((await probe(fakeProvider(), { fetchImpl })).outputExhausted, false);
});

test("probe: o canário pede mais orçamento de saída que a prova de tool_use", async () => {
  const seen = {};
  const fetchImpl = async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) {
      seen.toolUse = body.max_tokens;
      return jsonResponse(APPROVED_TOOL_USE);
    }
    if (body.max_tokens === 1) return jsonResponse({ stop_reason: "max_tokens", content: [] });
    seen.canary = body.max_tokens;
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "SENHA_INICIAL" }] });
  };
  await probe(fakeProvider(), { fetchImpl });
  assert.equal(seen.toolUse, 64);
  assert.ok(seen.canary > seen.toolUse);
});

test("describeDegradation: orçamento de saída esgotado não fala em truncamento de prompt", () => {
  const probeResult = {
    reachable: true,
    toolUse: true,
    contextOk: false,
    contextTimedOut: false,
    outputExhausted: true,
    redirect: null,
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.doesNotMatch(msg, /trunca/);
  assert.doesNotMatch(msg, /OLLAMA_CONTEXT_LENGTH/);
});

test("describeDegradation: orçamento de saída esgotado diz que o prompt foi lido e manda trocar o modelo", () => {
  const probeResult = {
    reachable: true,
    toolUse: true,
    contextOk: false,
    contextTimedOut: false,
    outputExhausted: true,
    redirect: null,
  };
  const msg = describeDegradation(probeResult, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /nightProvider\.model/);
  assert.match(msg, /raciocínio/);
});

test("describeDegradation: truncamento sem esgotamento segue palavra por palavra como hoje", () => {
  const truncated = { reachable: true, toolUse: true, contextOk: false, contextTimedOut: false, redirect: null };
  const msg = describeDegradation(truncated, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /trunca o prompt em silêncio/);
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH=65536/);
});

test("describeDegradation: esgotamento com redirect ou sem alcance perde para as pernas anteriores", () => {
  const withRedirect = {
    reachable: true,
    toolUse: true,
    contextOk: false,
    outputExhausted: true,
    redirect: { status: 302, location: "http://outro:11434/" },
  };
  assert.match(
    describeDegradation(withRedirect, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900),
    /redirect/,
  );
  const unreachable = { reachable: false, toolUse: false, contextOk: false, outputExhausted: true, redirect: null };
  assert.match(
    describeDegradation(unreachable, 65536, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900),
    /OLLAMA_HOST/,
  );
});

// --- o canário mede o próprio tamanho (issue #55) ---
//
// A constante `CANARY_CHARS_PER_TOKEN` errava 7% contra um modelo e 24% contra
// outro, sempre para menos: o Provedor era aprovado tendo provado menos
// contexto do que o operador declarou. A razão é propriedade do tokenizer do
// modelo, então nenhum número escrito aqui serviria. O que estes testes prendem
// é a medição substituindo a estimativa, e o que a sonda diz quando não mede.

/** Tokens que o canário se propõe a provar: o declarado menos o orçamento de
 *  saída, o mesmo `CANARY_MAX_TOKENS` que `probe()` pede na resposta. */
function targetTokens(minContext) {
  return minContext - 1024;
}

/** Piso da conferência: o alvo menos a folga que absorve a resolução da
 *  calibragem, o mesmo meio por cento de `CANARY_PROOF_SLACK`. */
function proofFloor(minContext) {
  return Math.floor(targetTokens(minContext) * 0.995);
}

test("canaryFiller: a razão entra como argumento e manda no tamanho do texto", () => {
  // 75 caracteres por unidade, e o filler sobe em unidades inteiras.
  assert.equal(canaryFiller(1000, 4).length, 4050);
  assert.equal(canaryFiller(1000, 8).length, 8025);
  assert.equal(canaryFiller(2000, 4).length, 8025);
});

test("canaryFiller: o texto que sai é CANARY_UNIT repetido, nunca cortado no meio", () => {
  const filler = canaryFiller(1000, 4);
  assert.equal(filler.length % 75, 0);
  assert.match(filler, /^texto de preenchimento/);
});

test("probe: a razão sai de dois pontos, e o envelope do chat cancela na subtração", async () => {
  // O Provedor simulado conta 12 tokens de template em todo pedido. Com um
  // ponto só a razão sairia baixa e o prompt nasceria curto; com dois, o
  // envelope some e o prompt cai dentro da banda entre o alvo e o declarado.
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationRatio: 5.353,
  });
  const result = await probe(fakeProvider({ minContext: 131072 }), { fetchImpl });
  assert.ok(result.contextTokens >= proofFloor(131072), `provou ${result.contextTokens} tokens`);
  assert.ok(result.contextTokens <= 131072, "o prompt não passa do contexto declarado");
});

test("probe: a razão medida vence a constante — dois tokenizers diferentes recebem prompts diferentes", async () => {
  const sizes = {};
  const capture = (ratio) => async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) return jsonResponse(APPROVED_TOOL_USE);
    const prompt = body.messages[0].content;
    if (body.max_tokens === 1) {
      return jsonResponse({ stop_reason: "max_tokens", content: [], usage: usageFor(prompt.length, ratio) });
    }
    sizes[ratio] = prompt.length;
    return jsonResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "SENHA_INICIAL" }],
      usage: usageFor(prompt.length, ratio),
    });
  };
  await probe(fakeProvider(), { fetchImpl: capture(4.41) });
  await probe(fakeProvider(), { fetchImpl: capture(5.353) });
  assert.ok(sizes[5.353] > sizes[4.41], "quem conta mais caracteres por token recebe mais caracteres");
});

test("probe: contextTokens é o que a prova alcançou, medido na resposta do canário", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "SENHA_INICIAL" });
  const result = await probe(fakeProvider({ minContext: 65536 }), { fetchImpl });
  assert.equal(typeof result.contextTokens, "number");
  assert.ok(result.contextTokens >= proofFloor(65536));
});

test("probe: canário reprovado não pronuncia contextTokens — num servidor que trunca, a contagem é de depois do corte", async () => {
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "A senha é SENHA_FINAL" });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, false);
  assert.equal(result.contextTokens, null);
});

test("probe: Provedor que responde sem usage aprova o canário e devolve contextTokens null", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationRatio: null,
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, true);
  assert.equal(result.contextTokens, null);
  assert.equal(result.contextTimedOut, false);
});

test("probe: timeout na calibragem vira contextTimedOut sem disparar o pedido grande", async () => {
  const big = [];
  const fetchImpl = async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    const body = JSON.parse(opts.body);
    if (body.tools) return jsonResponse(APPROVED_TOOL_USE);
    if (body.max_tokens === 1) throw timeoutError();
    big.push(body.messages[0].content.length);
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "SENHA_INICIAL" }] });
  };
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextTimedOut, true);
  assert.equal(result.contextOk, false);
  assert.equal(result.contextTokens, null);
  assert.deepEqual(big, [], "o prefill caro não é pago depois de a prova pequena estourar");
});

test("probe: erro que não é timeout na calibragem cai na constante e deixa o canário rodar", async () => {
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationError: new Error("status 500"),
  });
  const result = await probe(fakeProvider(), { fetchImpl });
  assert.equal(result.contextOk, true);
  assert.equal(result.contextTimedOut, false);
});

test("probe: o canário mira abaixo do contexto declarado, para não truncar a si mesmo", async () => {
  // O num_ctx do Ollama cobre prompt mais resposta: um prompt de exatamente
  // minContext estoura no Provedor cujo OLLAMA_CONTEXT_LENGTH bate com o
  // declarado, e ele reprovaria por integridade que tem.
  const fetchImpl = mockFetch({ toolUseResponse: APPROVED_TOOL_USE, canaryAnswer: "SENHA_INICIAL" });
  const result = await probe(fakeProvider({ minContext: 131072 }), { fetchImpl });
  assert.ok(result.contextTokens < 131072, "sobra orçamento de saída dentro do contexto declarado");
});

test("describeDegradation: prova aquém do alvo cita o medido contra o declarado", () => {
  const short = {
    reachable: true,
    toolUse: true,
    contextOk: true,
    contextTimedOut: false,
    outputExhausted: false,
    contextTokens: 100201,
    redirect: null,
  };
  const msg = describeDegradation(short, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /100201/);
  assert.match(msg, /131072/);
  assert.match(msg, /nightProvider\.minContext/);
});

test("describeDegradation: prova aquém do alvo assume o defeito da sonda, sem mandar reconfigurar o host", () => {
  const short = { reachable: true, toolUse: true, contextOk: true, contextTokens: 100201, redirect: null };
  const msg = describeDegradation(short, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /fora de suspeita/);
  assert.doesNotMatch(msg, /trunca/);
});

test("describeDegradation: prova dentro do alvo devolve null, como qualquer sonda aprovada", () => {
  const proved = { reachable: true, toolUse: true, contextOk: true, contextTokens: 130205, redirect: null };
  assert.equal(describeDegradation(proved, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900), null);
});

test("describeDegradation: canário sem medida não reprova — Provedor íntegro não morre por um campo que ele não devolve", () => {
  const notMeasured = { reachable: true, toolUse: true, contextOk: true, contextTokens: null, redirect: null };
  assert.equal(
    describeDegradation(notMeasured, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900),
    null,
  );
});

test("describeDegradation: prova aquém com contextOk verdadeiro nunca recebe a prosa de truncamento", () => {
  // A cascata decide por `contextOk`: com a senha do início na resposta, o
  // prompt não foi cortado, e um input_tokens baixo é a sonda que se
  // dimensionou mal, não o servidor cortando.
  const short = { reachable: true, toolUse: true, contextOk: true, contextTokens: 100201, redirect: null };
  const truncated = { reachable: true, toolUse: true, contextOk: false, contextTokens: null, redirect: null };
  const shortMsg = describeDegradation(short, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  const truncMsg = describeDegradation(truncated, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(truncMsg, /trunca o prompt em silêncio/);
  assert.doesNotMatch(shortMsg, /trunca o prompt em silêncio/);
});

test("describeAvailability: com a sonda em mãos, a linha verde diz quantos tokens foram provados", () => {
  const provider = resolve(baseCfg({ nightProvider: { minContext: 131072 } }), { night: true });
  const line = describeAvailability(provider, { contextOk: true, contextTokens: 130205 });
  assert.match(line, /130205/);
  assert.match(line, /131072/);
});

test("describeAvailability: sem medida, a linha verde diz que o tamanho não foi provado", () => {
  const provider = resolve(baseCfg(), { night: true });
  const line = describeAvailability(provider, { contextOk: true, contextTokens: null });
  assert.match(line, /não provado/);
  assert.match(line, /estimativa/);
});

test("describeAvailability: sem resultado de sonda, a linha é a de sempre", () => {
  const provider = resolve(baseCfg(), { night: true });
  assert.equal(describeAvailability(provider), `Provedor local disponível (modelo ${provider.model})`);
});

test("describeProbeStart: anuncia que o canário mede antes de montar o prompt grande", () => {
  const line = describeProbeStart(resolve(baseCfg(), { night: true }));
  assert.match(line, /mede quantos tokens/);
});

test("describeDegradation: prova a alguns tokens do alvo aprova — o piso desconta a resolução da calibragem", () => {
  // Medido em simulação: um Provedor de razão 4,41 com 131072 declarados fecha
  // em 130007 contra um alvo de 130048. Os 41 tokens são a razão saindo da
  // divisão de dois inteiros, e reprovar aqui seria a sonda acusando o Provedor
  // de um arredondamento dela.
  const rounded = { reachable: true, toolUse: true, contextOk: true, contextTokens: 130007, redirect: null };
  assert.equal(describeDegradation(rounded, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900), null);
});

test("describeDegradation: a folga do piso não cobre os 7% que a constante velha errava", () => {
  // 121592 tokens contra 131072 declarados é o que a issue #55 mediu com
  // CANARY_CHARS_PER_TOKEN dimensionando o prompt.
  const stale = { reachable: true, toolUse: true, contextOk: true, contextTokens: 121592, redirect: null };
  const msg = describeDegradation(stale, 131072, "http://host.docker.internal:11434", "ralph-alvo-1abc", 900);
  assert.match(msg, /121592/);
});

test("probe: o envelope do template é descontado do alvo, e o prompt não passa do contexto declarado", async () => {
  // Contra `devstral:24b` o envelope são 1226 tokens. Sem descontá-lo, um alvo
  // de 3072 virava um prompt de 4341 — acima do próprio minContext declarado,
  // e o Provedor cujo OLLAMA_CONTEXT_LENGTH bate com o declarado truncaria a
  // frente e reprovaria por integridade que tem.
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationRatio: 5,
    calibrationEnvelope: 1226,
  });
  const result = await probe(fakeProvider({ minContext: 4096 }), { fetchImpl });
  assert.ok(result.contextTokens <= 4096, `prompt de ${result.contextTokens} tokens contra 4096 declarados`);
  assert.ok(result.contextTokens >= proofFloor(4096), `prompt de ${result.contextTokens} tokens contra o alvo 3072`);
});

test("probe: envelope grande não sobra do orçamento de saída reservado", async () => {
  // A margem entre o provado e o declarado tem que caber a resposta inteira:
  // é o CANARY_MAX_TOKENS que o pedido pede.
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationRatio: 5,
    calibrationEnvelope: 1226,
  });
  const result = await probe(fakeProvider({ minContext: 131072 }), { fetchImpl });
  assert.ok(131072 - result.contextTokens >= 1000, `sobraram ${131072 - result.contextTokens} tokens de saída`);
});

test("probe: minContext menor que o envelope não estoura a sonda", async () => {
  // O config aceita qualquer inteiro positivo em minContext, e o filler não
  // pode nascer negativo por causa disso.
  const fetchImpl = mockFetch({
    toolUseResponse: APPROVED_TOOL_USE,
    canaryAnswer: "SENHA_INICIAL",
    calibrationRatio: 5,
    calibrationEnvelope: 1226,
  });
  const result = await probe(fakeProvider({ minContext: 512 }), { fetchImpl });
  assert.equal(result.contextOk, true);
});
