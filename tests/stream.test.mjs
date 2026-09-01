import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamRenderer,
  accumulateModelUsage,
  formatCostByModel,
  formatOrientationWarning,
  formatSkillFailureWarning,
  formatOrientationMissWarning,
  formatStuckLoop,
  foundPromise,
  parseOrientationStatus,
  orientationHalts,
  ORIENTATION_LOOP_LIMIT,
  MAIN_LOOP_LIMIT,
  ORIENTATION_TARGET_LOOP_LIMIT,
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

/** O mesmo turno, vindo do processo principal: o stream não marca `subagent_type`. */
function mainTool(id, name, input) {
  return {
    type: "assistant",
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
  assert.equal(state.stuckLoop?.count, ORIENTATION_LOOP_LIMIT + 2);
  assert.equal(state.stuckLoop?.tool, "Bash");
  assert.match(state.stuckLoop?.detail, /gh issue view 16/);
});

test("createStreamRenderer: a Orientação que lê muita coisa diferente não é laço", () => {
  const state = repeat(ORIENTATION_LOOP_LIMIT * 3, (i) =>
    orientationTool(`c${i}`, "Bash", { command: `gh issue view ${i} --json state` })
  );
  assert.equal(state.stuckLoop, null);
});

test("createStreamRenderer: a repetição do processo principal responde pelo teto do principal (issue #76)", () => {
  // A #74 media só a Orientação, e o principal repetindo passava batido — a
  // iteração das 19:18 de 28/08/2026 morreu assim, esperando o teto de tempo.
  const state = repeat(MAIN_LOOP_LIMIT, (i) => mainTool(`c${i}`, "Bash", VIEW_16));
  assert.equal(state.stuckLoop?.phase, "main");
});

test("createStreamRenderer: a repetição das iterações que entregaram fica abaixo do teto (issue #74)", () => {
  // Máximo medido em 28/08/2026 nas iterações com `result: success`: 2x.
  const state = repeat(2, (i) => orientationTool(`c${i}`, "Bash", VIEW_16));
  assert.equal(state.stuckLoop, null);
});

test("createStreamRenderer: o ciclo que alterna três tickets também é laço (issue #74)", () => {
  // Como a iteração das 20:03 começou: 18, 19, 20, 18, 19, 20 — nenhuma
  // repetição consecutiva, e ainda assim ninguém sai do lugar.
  const state = repeat(ORIENTATION_LOOP_LIMIT * 3, (i) =>
    orientationTool(`c${i}`, "Bash", { command: `gh issue view ${18 + (i % 3)} --json state` })
  );
  assert.equal(state.stuckLoop?.count, ORIENTATION_LOOP_LIMIT);
});

test("formatStuckLoop: nomeia o comando repetido e quantas vezes", () => {
  const line = formatStuckLoop({ phase: "orientation", tool: "Bash", detail: "gh issue view 16 --json state", count: 240 });
  assert.match(line, /240/);
  assert.match(line, /gh issue view 16/);
  assert.match(line, /Orientação/);
});

const PROGRESS = "/c/repo/.ralph/PROGRESS.md";

test("createStreamRenderer: a Orientação que anda o offset no mesmo arquivo vira laço (issue #75)", () => {
  // O laço de 01/09/2026: Reads do mesmo PROGRESS.md com o offset andando de
  // dois em dois. Nenhuma chamada idêntica chega perto do teto da #74 — a
  // repetição máxima por input inteiro foi 5.
  const PAGES = 8;
  const state = repeat(ORIENTATION_TARGET_LOOP_LIMIT + PAGES, (i) =>
    orientationTool(`c${i}`, "Read", { file_path: PROGRESS, offset: 250 + (i % PAGES) * 2 })
  );
  assert.equal(state.stuckLoop?.kind, "same-target");
  assert.equal(state.stuckLoop?.count, ORIENTATION_TARGET_LOOP_LIMIT);
  assert.equal(state.stuckLoop?.tool, "Read");
  assert.match(state.stuckLoop?.detail, /PROGRESS\.md/);
});

test("createStreamRenderer: a leitura paginada legítima não é laço (issue #75)", () => {
  // A iteração das 21:21 de 28/08/2026 fechou com `result: success` depois de
  // 186 Reads do mesmo arquivo — páginas distintas, mais nove que ela releu.
  // Página nova não conta nada; as nove releituras ficam abaixo do teto grosso.
  const LOCATE = "/c/repo/terracos/processing/locate.py";
  const renderer = createStreamRenderer();
  for (let i = 0; i < 200; i++) {
    feed(renderer, orientationTool(`p${i}`, "Read", { file_path: LOCATE, offset: 1400 - i * 10, limit: 30 }));
  }
  for (let i = 0; i < 9; i++) {
    feed(renderer, orientationTool(`r${i}`, "Read", { file_path: LOCATE, offset: 1400 - i * 10, limit: 30 }));
  }
  assert.equal(renderer.end().stuckLoop, null);
});

test("createStreamRenderer: a repetição idêntica continua sendo o laço da #74, não o do alvo", () => {
  // Repetir a chamada idêntica também acumula releitura do alvo, e o corte
  // sairia pelos dois. Quem responde é o teto fino: ele estoura antes e diz
  // com precisão o que o modelo repetiu.
  const state = repeat(ORIENTATION_TARGET_LOOP_LIMIT + 10, (i) => orientationTool(`c${i}`, "Bash", VIEW_16));
  assert.equal(state.stuckLoop?.kind, "same-input");
  assert.equal(state.stuckLoop?.count, ORIENTATION_TARGET_LOOP_LIMIT + 10);
});

test("createStreamRenderer: o laço por alvo cede ao laço por chamada dentro do mesmo chunk", () => {
  // O `abortWhen` de `runClaudeStreaming` roda depois de cada chunk, e um chunk
  // traz vários `tool_use`: dá para o teto grosso estourar e o fino estourar
  // logo atrás, com contagem menor. Quem responde é o fino.
  const renderer = createStreamRenderer();
  for (let volta = 0; volta < 2; volta++) {
    for (let i = 0; i <= ORIENTATION_TARGET_LOOP_LIMIT; i++) {
      feed(renderer, orientationTool(`p${volta}-${i}`, "Read", { file_path: PROGRESS, offset: i }));
    }
  }
  assert.equal(renderer.state.stuckLoop?.kind, "same-target");
  for (let i = 0; i < ORIENTATION_LOOP_LIMIT; i++) feed(renderer, orientationTool(`b${i}`, "Bash", VIEW_16));
  const loop = renderer.end().stuckLoop;
  assert.equal(loop?.kind, "same-input");
  assert.equal(loop?.count, ORIENTATION_LOOP_LIMIT);
});

test("formatStuckLoop: o laço que anda o argumento nomeia a ferramenta e o alvo", () => {
  const line = formatStuckLoop({ phase: "orientation", kind: "same-target", tool: "Read", detail: PROGRESS, count: 25 });
  assert.match(line, /25/);
  assert.match(line, /Read/);
  assert.match(line, /PROGRESS\.md/);
});

test("formatStuckLoop: a repetição idêntica mantém a linha da #74, palavra por palavra", () => {
  assert.equal(
    formatStuckLoop({ phase: "orientation", tool: "Bash", detail: "gh issue view 16 --json state", count: 240 }),
    "a Orientação repetiu 240x o mesmo Bash (gh issue view 16 --json state) — laço fechado"
  );
});

test("formatStuckLoop: sem laço, nenhuma linha", () => {
  assert.equal(formatStuckLoop(null), "");
});

const LOG_5 = { command: "git log --oneline -5", timeout: 5000 };
const VIEW_21 = { command: "gh issue view 21 --json number,title,body 2>&1 | head -40" };

test("createStreamRenderer: o laço do processo principal nomeia o comando repetido (issue #76)", () => {
  // A forma da iteração das 12:18 de 01/09/2026: dois comandos byte a byte
  // idênticos, alternados, dominam os 102 `tool_use` do principal. O laço
  // aparece onde o `abortWhen` cortaria — no vigésimo `git log`, não no
  // quadragésimo terceiro que o log inteiro traz, porque ali a iteração já
  // está morta.
  const renderer = createStreamRenderer();
  let usos = 0;
  while (!renderer.state.stuckLoop && usos < 102) {
    feed(renderer, mainTool(`a${usos}`, "Bash", LOG_5));
    feed(renderer, mainTool(`b${usos}`, "Bash", VIEW_21));
    usos += 2;
  }
  const loop = renderer.end().stuckLoop;
  assert.equal(loop?.phase, "main");
  assert.equal(loop?.count, MAIN_LOOP_LIMIT);
  assert.match(loop?.detail, /git log --oneline -5/);
  assert.equal(usos, MAIN_LOOP_LIMIT * 2);
});

test("createStreamRenderer: o teto do principal é mais alto que o da Orientação (issue #76)", () => {
  // A iteração que trabalha roda a mesma suíte e o mesmo `git status` de novo
  // de forma legítima; a Orientação lê e relata, e não deveria repetir nada.
  assert.ok(MAIN_LOOP_LIMIT > ORIENTATION_LOOP_LIMIT);
  const state = repeat(ORIENTATION_LOOP_LIMIT, (i) => mainTool(`c${i}`, "Bash", LOG_5));
  assert.equal(state.stuckLoop, null);
});

test("createStreamRenderer: a repetição das iterações que entregaram fica abaixo do teto do principal (issue #76)", () => {
  // Máximo do principal nas 71 iterações que fecharam com `result: success`:
  // 6x um `Bash true` numa iteração de 90 turnos que entregou (24/08/2026 20:26).
  const state = repeat(6, (i) => mainTool(`c${i}`, "Bash", { command: "true" }));
  assert.equal(state.stuckLoop, null);
});

test("createStreamRenderer: o principal que relê o mesmo arquivo em páginas novas não é laço (issue #76)", () => {
  // O teto grosso da #75 não vale aqui: a iteração que implementa relê e
  // reescreve o mesmo arquivo o tempo todo, e o alvo repetido é rotina dela.
  const state = repeat(MAIN_LOOP_LIMIT * 3, (i) =>
    mainTool(`c${i}`, "Read", { file_path: PROGRESS, offset: i * 2 })
  );
  assert.equal(state.stuckLoop, null);
});

test("createStreamRenderer: a fase que travou primeiro responde pela iteração (issue #76)", () => {
  // O laço do principal não apaga o da Orientação: a delegação estourou antes,
  // e é ela que o operador precisa consertar.
  const renderer = createStreamRenderer();
  for (let i = 0; i < ORIENTATION_LOOP_LIMIT; i++) feed(renderer, orientationTool(`o${i}`, "Bash", VIEW_16));
  for (let i = 0; i < MAIN_LOOP_LIMIT * 2; i++) feed(renderer, mainTool(`m${i}`, "Bash", LOG_5));
  assert.equal(renderer.end().stuckLoop?.phase, "orientation");
});

test("formatStuckLoop: o laço do principal nomeia o processo principal, não a Orientação (issue #76)", () => {
  assert.equal(
    formatStuckLoop({ phase: "main", tool: "Bash", detail: "git log --oneline -5", count: 20 }),
    "o processo principal repetiu 20x o mesmo Bash (git log --oneline -5) — laço fechado"
  );
});

/** Um turno de raciocínio, do processo principal ou de um subagente. */
function thinkingTurn(thinking, subagentType) {
  const evt = {
    type: "assistant",
    message: { role: "assistant", model: "ornith:9b", content: [{ type: "thinking", thinking }] },
  };
  if (subagentType) evt.subagent_type = subagentType;
  return evt;
}

test("foundPromise: a promise que a iteração só pensou é encontrada (issue #70)", () => {
  // A corrida de 01/09/2026 contra `ornith:9b`, num alvo sem issue tracker,
  // palavra por palavra: o raciocínio anuncia a promise e o texto final sai
  // sem ela.
  const renderer = createStreamRenderer();
  feed(
    renderer,
    thinkingTurn(
      "The repository is a test repo with only a README commit.\n\n" +
        "I should emit `<promise>BLOCKED</promise>` with a clear explanation."
    )
  );
  feed(renderer, {
    type: "result",
    subtype: "success",
    result: "The repository contains only a single commit (README). There's nothing to implement.",
  });
  const state = renderer.end();
  assert.equal(foundPromise(state, "BLOCKED", { includeThinking: true }), true);
});

test("foundPromise: sem includeThinking, a promise pensada não conta (issue #70)", () => {
  // O padrão é o de antes da #70, e é ele que `runIteration` usa para
  // `COMPLETE`: o passo 2 do prompt lista as duas tags, e um "não é
  // <promise>COMPLETE</promise>" pensado fecharia a noite como sucesso.
  const renderer = createStreamRenderer();
  feed(renderer, thinkingTurn("STATUS is ready, so this is not <promise>COMPLETE</promise>."));
  const state = renderer.end();
  assert.equal(foundPromise(state, "COMPLETE"), false);
});

test("foundPromise: o raciocínio da Orientação não emite promise pela iteração (issue #70)", () => {
  // O prompt do subagente cita a promise para dizer que emiti-la é papel da
  // iteração — o raciocínio dele sobre ela não pode parar o loop.
  const renderer = createStreamRenderer();
  feed(renderer, thinkingTurn("The iteration should emit <promise>BLOCKED</promise>.", "orientation"));
  const state = renderer.end();
  assert.equal(foundPromise(state, "BLOCKED", { includeThinking: true }), false);
});

test("foundPromise: nem o do subagente que o agente delega sozinho (issue #70)", () => {
  // O `general-purpose` que o Claude Code dispara por conta própria não viu o
  // passo 2 do prompt da iteração, e o que ele pensa não fala por ela.
  const renderer = createStreamRenderer();
  feed(renderer, thinkingTurn("Nothing here. <promise>BLOCKED</promise>", "general-purpose"));
  const state = renderer.end();
  assert.equal(foundPromise(state, "BLOCKED", { includeThinking: true }), false);
});

test("foundPromise: a promise escrita como texto continua contando", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Backlog vazio. <promise>COMPLETE</promise>" }] },
  });
  const state = renderer.end();
  assert.equal(foundPromise(state, "COMPLETE"), true);
  assert.equal(foundPromise(state, "BLOCKED", { includeThinking: true }), false);
});

/**
 * O resumo de orientação da rodada de 01/09/2026 15:10Z no alvo Terraços
 * (issue #79): bem formado, `STATUS: blocked`, e um `CONTEXT` com a receita
 * completa do que implementar. A iteração implementou assim mesmo.
 */
const BLOCKED_SUMMARY = [
  "STATUS: blocked",
  "TICKET: (none — frontier empty)",
  "CLAIM: (empty)",
  "WHY: nenhuma issue ready-for-agent na frente; a #19 está aberta mas sem label.",
  "CONTEXT: - terracos/core/ends.py: a tolerância de encosto da ponta de jusante",
  "  falta em `locate_ends`; a fórmula é `abs(z - z0) <= tol`.",
].join("\n");

test("parseOrientationStatus: lê o STATUS do resumo bloqueado da issue #79", () => {
  assert.equal(parseOrientationStatus(BLOCKED_SUMMARY), "blocked");
  assert.equal(parseOrientationStatus(SUMMARY), "ready");
});

test("parseOrientationStatus: texto sem a linha do contrato não tem STATUS", () => {
  assert.equal(parseOrientationStatus("The orientation agent hit an output limit."), null);
  assert.equal(parseOrientationStatus(""), null);
});

test("parseOrientationStatus: o eco do rótulo do contrato sai como ready, e não corta nada", () => {
  // `STATUS: ready | complete | blocked` é o rótulo do bloco de exemplo. Ler a
  // primeira palavra é o que impede um resumo que copia o template de ser
  // confundido com um veredicto de bloqueio.
  assert.equal(parseOrientationStatus("STATUS: ready | complete | blocked\nTICKET: ..."), "ready");
});

test("orientationHalts: só complete e blocked param a iteração", () => {
  assert.equal(orientationHalts("blocked"), true);
  assert.equal(orientationHalts("complete"), true);
  assert.equal(orientationHalts("ready"), false);
  assert.equal(orientationHalts(null), false);
});

test("createStreamRenderer: o resumo bloqueado guarda o STATUS que corta a iteração (issue #79)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { description: "orient", subagent_type: "orientation", run_in_background: false }));
  feed(renderer, toolResult("toolu_1", { content: [{ type: "text", text: BLOCKED_SUMMARY }] }));
  const state = renderer.end();
  assert.equal(state.orientationSummaries, 1);
  assert.equal(state.orientationStatus, "blocked");
  assert.equal(orientationHalts(state.orientationStatus), true);
});

test("createStreamRenderer: o resumo ready não corta nada (issue #79)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { description: "orient", subagent_type: "orientation", run_in_background: false }));
  feed(renderer, toolResult("toolu_1", { content: [{ type: "text", text: SUMMARY }] }));
  const state = renderer.end();
  assert.equal(state.orientationStatus, "ready");
  assert.equal(orientationHalts(state.orientationStatus), false);
});

test("createStreamRenderer: o que não é resumo de orientação não vira STATUS (issue #79)", () => {
  const renderer = createStreamRenderer();
  // Um `Bash` do principal que grepa os próprios logs do Ralph traz a linha
  // `STATUS:` no `tool_result` sem nunca ter passado pela Orientação.
  feed(renderer, mainTool("toolu_1", "Bash", { command: "grep -r STATUS: .ralph/logs" }));
  feed(renderer, toolResult("toolu_1", { content: "STATUS: blocked" }));
  const state = renderer.end();
  assert.equal(state.orientationStatus, null);
});

test("createStreamRenderer: delegação que volta com erro não deixa STATUS (issue #79)", () => {
  const renderer = createStreamRenderer();
  feed(renderer, delegation("toolu_1", { description: "orient", subagent_type: "orientation" }));
  feed(renderer, toolResult("toolu_1", { is_error: true, content: "STATUS: blocked" }));
  const state = renderer.end();
  assert.equal(state.orientationStatus, null);
});
