import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamRenderer,
  accumulateModelUsage,
  formatCostByModel,
  formatOrientationWarning,
  formatSkillFailureWarning,
  formatOrientationMissWarning,
  formatOrientationLoop,
  ORIENTATION_LOOP_LIMIT,
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
  assert.equal(formatCostByModel(0, {}, { fallback: "custo não reportado" }), "custo não reportado");
});

test("formatCostByModel: Provedor que não cobra usa o fallback mesmo com total reportado", () => {
  const costing = { billed: false, fallback: "sem custo — Provedor local (ornith:9b)" };
  const line = formatCostByModel(48.77, { "ornith:9b": 48.77 }, costing);
  assert.equal(line, "sem custo — Provedor local (ornith:9b)");
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

test("createStreamRenderer: registra a skill cuja chamada voltou com erro (issue #72)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "code-review" } }] },
  });
  feed(renderer, {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Skill code-review cannot be used with Skill tool due to disable-model-invocation" }],
    },
  });
  const state = renderer.end();
  assert.deepEqual(state.failedSkills, ["code-review"]);
});

test("createStreamRenderer: skill que rodou não entra na lista, nem erro de outra tool", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "mattpocock-skills:code-review" } },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "git status" } },
      ],
    },
  });
  feed(renderer, {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "fatal: not a git repository" },
      ],
    },
  });
  const state = renderer.end();
  assert.deepEqual(state.failedSkills, []);
});

test("createStreamRenderer: a mesma skill falhando duas vezes vira uma linha só", () => {
  const renderer = createStreamRenderer();
  for (const id of ["toolu_1", "toolu_2"]) {
    feed(renderer, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Skill", input: { skill: "code-review" } }] },
    });
    feed(renderer, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "disable-model-invocation" }] },
    });
  }
  const state = renderer.end();
  assert.deepEqual(state.failedSkills, ["code-review"]);
});

test("formatSkillFailureWarning: sem falha, silêncio", () => {
  assert.equal(formatSkillFailureWarning([]), "");
});

test("formatSkillFailureWarning: nomeia a skill que falhou e diz que o passo não rodou", () => {
  const line = formatSkillFailureWarning(["code-review"]);
  assert.match(line, /code-review/);
  assert.match(line, /não rodou/);
});

test("createStreamRenderer: falha seguida do acerto com o nome qualificado não vira aviso (issue #72)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "code-review" } }] },
  });
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "disable-model-invocation" }] },
  });
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Skill", input: { skill: "mattpocock-skills:code-review" } }] },
  });
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "Launching skill" }] },
  });
  const state = renderer.end();
  assert.deepEqual(state.failedSkills, []);
});

test("createStreamRenderer: acerto em outra skill não apaga a que ficou por fazer", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "code-review" } }] },
  });
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "disable-model-invocation" }] },
  });
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Skill", input: { skill: "mattpocock-skills:tdd" } }] },
  });
  feed(renderer, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "Launching skill" }] },
  });
  const state = renderer.end();
  assert.deepEqual(state.failedSkills, ["code-review"]);
});

/** O resumo de orientação como `prompts/orientation.md` manda devolvê-lo. */
const SUMMARY = "STATUS: ready\nTICKET: #66 o relatório da iteração\nWHY: primeiro da frente\nCONTEXT: - src/stream.mjs";

function delegation(id, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Task", input }] } };
}

function toolResult(id, extra = {}) {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...extra }] } };
}

test("createStreamRenderer: o resumo que volta do subagente orientation é contado (issue #66)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { description: "orient", subagent_type: "orientation", run_in_background: false }));
  feed(renderer, toolResult("toolu_1", { content: [{ type: "text", text: SUMMARY }] }));
  const state = renderer.end();
  assert.equal(state.orientationSummaries, 1);
  assert.equal(state.orientationDelegatedTo, "orientation");
});

test("createStreamRenderer: delegação que volta com erro não conta como resumo", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { subagent_type: "orientation" }));
  feed(renderer, toolResult("toolu_1", { is_error: true, content: "InputValidationError: description is required" }));
  const state = renderer.end();
  assert.equal(state.orientationSummaries, 0);
});

test("createStreamRenderer: prosa fora do contrato não conta como resumo (issue #66)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { subagent_type: "orientation", run_in_background: false }));
  // A iteração das 14:42: o subagente estourou o orçamento de saída e voltou
  // sem `is_error`, então "sem erro" sozinho contaria isto como resumo.
  feed(renderer, toolResult("toolu_1", { content: [{ type: "text", text: "The orientation agent hit an output limit." }] }));
  const state = renderer.end();
  assert.equal(state.orientationSummaries, 0);
});

test("createStreamRenderer: recibo de lançamento não conta como resumo (issue #65 dentro da #66)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { subagent_type: "orientation", run_in_background: true }));
  feed(renderer, toolResult("toolu_1", { content: "Async agent launched successfully." }));
  const state = renderer.end();
  assert.equal(state.orientationSummaries, 0);
  assert.equal(state.orientationDelegatedTo, "orientation");
});

test("createStreamRenderer: a delegação a orientation vence a que veio antes dela", () => {
  const renderer = createStreamRenderer();
  // O Claude Code dispara subagente por conta própria; se ele vier antes do
  // passo 1, quem responde pela Orientação continua sendo a chamada certa.
  feed(renderer, delegation("toolu_1", { description: "explora", subagent_type: "Explore" }));
  feed(renderer, delegation("toolu_2", { description: "orient", subagent_type: "orientation" }));
  const state = renderer.end();
  assert.equal(state.orientationDelegatedTo, "orientation");
});

test("createStreamRenderer: sem delegação a orientation, a primeira da iteração responde por ela", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { description: "orient", subagent_type: "general-purpose" }));
  feed(renderer, delegation("toolu_2", { description: "explora", subagent_type: "Explore" }));
  const state = renderer.end();
  assert.equal(state.orientationDelegatedTo, "general-purpose");
});

test("createStreamRenderer: sem delegação nenhuma, orientationDelegatedTo fica null", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "gh issue list" } }] },
  });
  const state = renderer.end();
  assert.equal(state.orientationDelegatedTo, null);
  assert.equal(state.orientationSummaries, 0);
});

test("formatOrientationMissWarning: iteração saudável não ganha linha nenhuma", () => {
  assert.equal(formatOrientationMissWarning(1, "orientation"), "");
  // O Claude Code delega por conta própria depois da Orientação; o resumo já
  // chegou, então nada disso vira aviso.
  assert.equal(formatOrientationMissWarning(1, "general-purpose"), "");
});

test("formatOrientationMissWarning: sem resumo nenhum, nomeia o contexto principal", () => {
  const line = formatOrientationMissWarning(0, "orientation");
  assert.match(line, /contexto principal/);
  assert.match(line, /ADR-0004/);
  assert.equal(formatOrientationMissWarning(0, null), line);
});

test("formatOrientationMissWarning: subagent_type errado nomeia o agente e o orientationModel ignorado", () => {
  const line = formatOrientationMissWarning(0, "general-purpose");
  assert.match(line, /general-purpose/);
  assert.match(line, /ADR-0004/);
  assert.match(line, /orientationModel/);
});

test("createStreamRenderer + formatOrientationMissWarning: a iteração das 14:42 vira aviso (issue #66)", () => {
  const renderer = createStreamRenderer();
  // A chamada sem `description` reprova, a repetição põe `description` e perde
  // o `subagent_type: "orientation"` — foi como `general-purpose` que rodou.
  feed(renderer, delegation("toolu_1", { subagent_type: "general-purpose", description: "orient" }));
  feed(renderer, toolResult("toolu_1", { content: [{ type: "text", text: "hit an output limit" }] }));
  feed(renderer, { type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 40 });
  const state = renderer.end();
  assert.match(formatOrientationMissWarning(state.orientationSummaries, state.orientationDelegatedTo), /general-purpose/);
});

test("createStreamRenderer + formatOrientationMissWarning: a iteração das 14:12 vira aviso (issue #66)", () => {
  const renderer = createStreamRenderer();
  // Delegou certo, o resumo nunca voltou, e o principal orientou sozinho.
  feed(renderer, delegation("toolu_1", { subagent_type: "orientation", description: "orient" }));
  feed(renderer, toolResult("toolu_1", { is_error: true, content: "timed out after 120s" }));
  feed(renderer, { type: "result", subtype: "success", total_cost_usd: 2.9, num_turns: 118 });
  const state = renderer.end();
  assert.match(formatOrientationMissWarning(state.orientationSummaries, state.orientationDelegatedTo), /contexto principal/);
});

/** Um turno do subagente `orientation`: o modelo pede uma ferramenta e nada mais. */
function orientationTool(id, name, input) {
  return {
    type: "assistant",
    subagent_type: "orientation",
    message: { role: "assistant", model: "ornith:9b", content: [{ type: "tool_use", id, name, input }] },
  };
}

function repeat(n, fn) {
  const renderer = createStreamRenderer();
  for (let i = 0; i < n; i++) feed(renderer, fn(i));
  return renderer.end();
}

const VIEW_16 = { command: "gh issue view 16 --json number,title,state,labels" };

test("createStreamRenderer: a Orientação que repete o mesmo tool_use vira laço (issue #74)", () => {
  const state = repeat(ORIENTATION_LOOP_LIMIT + 2, (i) => orientationTool(`c${i}`, "Bash", VIEW_16));
  assert.equal(state.orientationLoop?.count, ORIENTATION_LOOP_LIMIT + 2);
  assert.equal(state.orientationLoop?.tool, "Bash");
  assert.match(state.orientationLoop?.detail, /gh issue view 16/);
});

test("createStreamRenderer: a Orientação que lê muita coisa diferente não é laço", () => {
  const state = repeat(ORIENTATION_LOOP_LIMIT * 3, (i) =>
    orientationTool(`c${i}`, "Bash", { command: `gh issue view ${i} --json state` })
  );
  assert.equal(state.orientationLoop, null);
});

test("createStreamRenderer: repetição no contexto principal não é laço da Orientação (issue #74)", () => {
  // O agente principal que repete um comando é outro sintoma — a iteração das
  // 19:18 de 28/08/2026 morreu assim, e o teto de tempo é quem responde por ela.
  const state = repeat(ORIENTATION_LOOP_LIMIT * 2, (i) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: VIEW_16 }] },
  }));
  assert.equal(state.orientationLoop, null);
});

test("createStreamRenderer: a repetição das iterações que entregaram fica abaixo do teto (issue #74)", () => {
  // Máximo medido em 28/08/2026 nas iterações com `result: success`: 2x.
  const state = repeat(2, (i) => orientationTool(`c${i}`, "Bash", VIEW_16));
  assert.equal(state.orientationLoop, null);
});

test("createStreamRenderer: o ciclo que alterna três tickets também é laço (issue #74)", () => {
  // Como a iteração das 20:03 começou: 18, 19, 20, 18, 19, 20 — nenhuma
  // repetição consecutiva, e ainda assim ninguém sai do lugar.
  const state = repeat(ORIENTATION_LOOP_LIMIT * 3, (i) =>
    orientationTool(`c${i}`, "Bash", { command: `gh issue view ${18 + (i % 3)} --json state` })
  );
  assert.equal(state.orientationLoop?.count, ORIENTATION_LOOP_LIMIT);
});

test("formatOrientationLoop: nomeia o comando repetido e quantas vezes", () => {
  const line = formatOrientationLoop({ tool: "Bash", detail: "gh issue view 16 --json state", count: 240 });
  assert.match(line, /240/);
  assert.match(line, /gh issue view 16/);
  assert.match(line, /Orientação/);
});

test("formatOrientationLoop: sem laço, nenhuma linha", () => {
  assert.equal(formatOrientationLoop(null), "");
});
