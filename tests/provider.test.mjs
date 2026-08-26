import test from "node:test";
import assert from "node:assert/strict";
import { resolve, renderEnv, requiresAnthropicAuth, DEFAULT_NIGHT_PROVIDER } from "../src/provider.mjs";

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
