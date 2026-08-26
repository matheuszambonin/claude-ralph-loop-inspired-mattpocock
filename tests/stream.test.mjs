import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamRenderer,
  accumulateModelUsage,
  formatCostByModel,
  formatOrientationWarning,
} from "../src/stream.mjs";

function feed(renderer, evt) {
  renderer.write(JSON.stringify(evt) + "\n");
}

test("createStreamRenderer: guarda mcp_servers do evento init, como já guarda skills", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "system",
    subtype: "init",
    session_id: "abc123",
    model: "sonnet",
    tools: [],
    skills: ["mattpocock-skills:implement"],
    mcp_servers: [{ name: "code-review-graph", status: "failed" }],
  });
  const state = renderer.end();
  assert.deepEqual(state.mcpServers, [{ name: "code-review-graph", status: "failed" }]);
});

test("createStreamRenderer: init sem mcp_servers deixa o estado null", () => {
  const renderer = createStreamRenderer();
  feed(renderer, { type: "system", subtype: "init", session_id: "abc123", model: "sonnet", tools: [] });
  const state = renderer.end();
  assert.equal(state.mcpServers, null);
});

test("createStreamRenderer: guarda modelUsage do evento result", () => {
  const renderer = createStreamRenderer();
  const modelUsage = {
    "claude-sonnet-5": { inputTokens: 42, outputTokens: 16720, costUSD: 1.04 },
    "claude-haiku-4-5-20251001": { inputTokens: 2, outputTokens: 90, costUSD: 0.02 },
  };
  feed(renderer, { type: "result", subtype: "success", total_cost_usd: 1.06, num_turns: 12, modelUsage });
  const state = renderer.end();
  assert.deepEqual(state.modelUsage, modelUsage);
});

test("createStreamRenderer: result sem modelUsage deixa o estado no valor neutro", () => {
  const renderer = createStreamRenderer();
  feed(renderer, { type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 3 });
  const state = renderer.end();
  assert.equal(state.modelUsage, null);
});

test("createStreamRenderer: soma subagent_tokens do <usage> devolvido pelo Agent tool", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "revisa o diff" } },
        { type: "tool_use", id: "toolu_2", name: "Agent", input: { description: "confere a spec" } },
      ],
    },
  });
  feed(renderer, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "resumo do subagente\n<usage>subagent_tokens: 39541\ntool_uses: 9\nduration_ms: 83256</usage>" }],
        },
      ],
    },
  });
  feed(renderer, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: [{ type: "text", text: "outro subagente\n<usage>subagent_tokens: 3728\ntool_uses: 2\nduration_ms: 5100</usage>" }],
        },
      ],
    },
  });
  const state = renderer.end();
  assert.equal(state.subagentTokens, 39541 + 3728);
});

test("createStreamRenderer: sem tool_result de subagente, subagentTokens fica em 0", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "resultado normal, sem uso de subagente" }] }] },
  });
  const state = renderer.end();
  assert.equal(state.subagentTokens, 0);
});

test("accumulateModelUsage: soma o custo por modelo entre duas iterações", () => {
  let totals = {};
  totals = accumulateModelUsage(totals, { "claude-sonnet-5": { costUSD: 1.0 } });
  totals = accumulateModelUsage(totals, {
    "claude-sonnet-5": { costUSD: 0.5 },
    "claude-haiku-4-5-20251001": { costUSD: 0.1 },
  });
  assert.deepEqual(totals, { "claude-sonnet-5": 1.5, "claude-haiku-4-5-20251001": 0.1 });
});

test("accumulateModelUsage: modelUsage ausente não altera o total acumulado", () => {
  const totals = { "claude-sonnet-5": 1.5 };
  assert.deepEqual(accumulateModelUsage(totals, null), totals);
  assert.deepEqual(accumulateModelUsage(totals, undefined), totals);
});

test("formatCostByModel: um modelo só produz a mesma string de antes desta feature", () => {
  assert.equal(formatCostByModel(1.04, { "claude-sonnet-5": 1.04 }), "$1.0400");
  assert.equal(formatCostByModel(1.04, {}), "$1.0400");
});

test("formatCostByModel: dois modelos produzem a linha com os dois", () => {
  const line = formatCostByModel(12.88, { "claude-sonnet-5": 11.2, "claude-haiku-4-5-20251001": 1.68 });
  assert.equal(line, "$12.8800 (sonnet $11.2000 · haiku $1.6800)");
});

test("formatCostByModel: custo não reportado usa o fallback", () => {
  assert.equal(formatCostByModel(0, {}, "custo não reportado"), "custo não reportado");
});

test("createStreamRenderer: subagent_tokens na saída de um Bash não entra na conta", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "grep subagent_tokens .ralph/logs/*.jsonl" } }] },
  });
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: [{ type: "text", text: "iter-03.jsonl: subagent_tokens: 99999" }] }] },
  });
  const state = renderer.end();
  assert.equal(state.subagentTokens, 0);
});

test("createStreamRenderer: conta as invocações da Orientação, e só as dela", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "orientation" } },
        { type: "tool_use", id: "toolu_2", name: "Agent", input: { description: "o Claude Code delega por conta própria" } },
        { type: "tool_use", id: "toolu_3", name: "Agent", input: { subagent_type: "orientation" } },
      ],
    },
  });
  const state = renderer.end();
  assert.equal(state.orientationCalls, 2);
});

test("createStreamRenderer + formatOrientationWarning: iteração que morre antes do `result` ainda avisa (issue #44)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "orientation" } },
        { type: "tool_use", id: "toolu_2", name: "Agent", input: { subagent_type: "orientation" } },
      ],
    },
  });
  // sem `result`: timeout, kill ou erro de transporte — o caso que a #44 veio consertar.
  const state = renderer.end();
  assert.notEqual(formatOrientationWarning(state.orientationCalls), "");
});

test("createStreamRenderer: estourar o teto avisa, mas não reprova a iteração", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "orientation" } },
        { type: "tool_use", id: "toolu_2", name: "Agent", input: { subagent_type: "orientation" } },
      ],
    },
  });
  feed(renderer, { type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 3 });
  const state = renderer.end();
  assert.equal(state.orientationCalls, 2);
  assert.equal(state.isError, false);
});

test("formatOrientationWarning: uma orientação por iteração não imprime nada", () => {
  assert.equal(formatOrientationWarning(1), "");
  assert.equal(formatOrientationWarning(0), "");
});

test("formatOrientationWarning: mais de uma orientação avisa e diz qual é o teto", () => {
  const line = formatOrientationWarning(2);
  assert.match(line, /2 orientações/);
  assert.match(line, /ADR-0004/);
});

test("formatCostByModel: sem custo total, a quebra por modelo vira o total", () => {
  const line = formatCostByModel(0, { "claude-sonnet-4-5": 1.2, "claude-haiku-4-5": 0.08 });
  assert.match(line, /\$1\.2800/);
  assert.match(line, /sonnet \$1\.2000/);
  assert.match(line, /haiku \$0\.0800/);
});
