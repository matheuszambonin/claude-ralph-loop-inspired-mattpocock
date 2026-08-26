import test from "node:test";
import assert from "node:assert/strict";
import {
  resolve,
  renderEnv,
  requiresAnthropicAuth,
  probe,
  preload,
  describeAvailability,
  describeDegradation,
  DEFAULT_NIGHT_PROVIDER,
} from "../src/provider.mjs";

function baseCfg(overrides = {}) {
  return { model: "sonnet", orientationModel: "haiku", ...overrides };
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
  assert.equal(resolve(baseCfg(), { night: true }).model, DEFAULT_NIGHT_PROVIDER.model);
});

test("resolve: com night, endereço de loopback do config é traduzido pro host do Docker", () => {
  const cfg = baseCfg({ nightProvider: { baseUrl: "http://127.0.0.1:11434/v1" } });
  assert.equal(resolve(cfg, { night: true }).baseUrl, "http://host.docker.internal:11434/v1");
});

test("resolve: com night e keepAlive ausente do config, o padrão cobre uma noite inteira", () => {
  const provider = resolve(baseCfg({ nightProvider: { model: "qwen3-coder:30b" } }), { night: true });
  assert.equal(provider.keepAlive, DEFAULT_NIGHT_PROVIDER.keepAlive);
});

test("resolve: com night e keepAlive declarado no config, o valor do operador vence o padrão", () => {
  const cfg = baseCfg({ nightProvider: { model: "qwen3-coder:30b", keepAlive: "30m" } });
  assert.equal(resolve(cfg, { night: true }).keepAlive, "30m");
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
  return { kind: "local", baseUrl: "http://fake-ollama:11434", model: "test-model", orientationModel: "test-model", ...overrides };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** fetchImpl injetado: `/api/tags` sempre aprova, `/v1/messages` devolve a
 *  resposta de tool_use quando o corpo declara `tools`, senão a do canário. */
function mockFetch({ toolUseResponse, canaryAnswer }) {
  return async (url, opts) => {
    if (url.endsWith("/api/tags")) return jsonResponse({});
    if (url.endsWith("/v1/messages")) {
      const body = JSON.parse(opts.body);
      if (body.tools) return jsonResponse(toolUseResponse);
      return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: canaryAnswer }] });
    }
    throw new Error("url inesperada: " + url);
  };
}

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
  assert.deepEqual(result, { reachable: false, toolUse: false, contextOk: false, answered: null });
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
  const msg = describeAvailability(resolve({ nightProvider: { model: "qwen3-coder:30b" } }, { night: true }));
  assert.match(msg, /Provedor local/);
  assert.match(msg, /qwen3-coder:30b/);
  assert.doesNotMatch(msg, /Ollama/i);
});

test("describeDegradation: sonda aprovada em tudo devolve null", () => {
  assert.equal(describeDegradation({ reachable: true, toolUse: true, contextOk: true, answered: "SENHA_INICIAL" }), null);
});

test("describeDegradation: inalcançável nomeia OLLAMA_HOST", () => {
  const msg = describeDegradation({ reachable: false, toolUse: false, contextOk: false, answered: null });
  assert.match(msg, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("describeDegradation: sem tool_use pede pra trocar de modelo em nightProvider.model", () => {
  const msg = describeDegradation({ reachable: true, toolUse: false, contextOk: false, answered: null });
  assert.match(msg, /nightProvider\.model/);
});

test("describeDegradation: canário reprovado nomeia OLLAMA_CONTEXT_LENGTH", () => {
  const msg = describeDegradation({ reachable: true, toolUse: true, contextOk: false, answered: "SENHA_FINAL" });
  assert.match(msg, /OLLAMA_CONTEXT_LENGTH/);
});
