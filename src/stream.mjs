/**
 * Renderizador do `--output-format stream-json` do Claude Code.
 *
 * Faz o papel que o filtro jq faz nos artigos do aihero.dev, mas em Node:
 * a máquina não tem jq, e o parsing de JSON aqui é mais tolerante a linhas
 * partidas do que um pipe `grep '^{' | jq --unbuffered`.
 */

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);

/** Resumo de uma linha para o uso de uma ferramenta. */
function describeTool(name, input = {}) {
  const first = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === "string");
  switch (name) {
    case "Bash":
      return input.command?.split("\n")[0]?.slice(0, 120) ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return first("file_path", "notebook_path") ?? "";
    case "Grep":
    case "Glob":
      return [input.pattern, input.path].filter(Boolean).join("  ").slice(0, 120);
    case "Task":
    case "Agent":
      return first("description", "subagent_type") ?? "";
    case "Skill":
      return [input.skill, input.args].filter(Boolean).join(" ").slice(0, 120);
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return `${done}/${todos.length} concluídos`;
    }
    default: {
      const guess = first("file_path", "path", "query", "prompt", "url", "command");
      return guess ? guess.slice(0, 120) : "";
    }
  }
}

/**
 * Quantas vezes a Orientação pode repetir o mesmo `tool_use` antes de o Ralph
 * chamar aquilo de laço e cortar a iteração (issue #74). Máximo medido nas
 * iterações que entregaram: 2 repetições. Mínimo nas que travaram: 19. Dez
 * fica no meio da folga, longe das duas pontas.
 */
export const ORIENTATION_LOOP_LIMIT = 10;

/**
 * Quantas chamadas já feitas a Orientação pode refazer no mesmo alvo — a mesma
 * ferramenta sobre o mesmo arquivo, comando ou padrão — antes de o Ralph
 * chamar aquilo de laço (issue #75). Teto próprio, e mais alto, porque a chave
 * é mais grossa: o laço de 01/09/2026 andava o `offset` de dois em dois sobre
 * o mesmo `PROGRESS.md`, e nenhuma chamada idêntica passou de 5.
 *
 * Vinte e cinco fica entre as duas pontas medidas nos 20 logs reais em que
 * a Orientação chegou a usar ferramenta: o pior
 * caso legítimo é a iteração das 21:21 de 28/08/2026, que releu 9 páginas de
 * um arquivo de 1400 linhas e ainda assim entregou; o laço do dia 01/09 refez
 * 60. Contar só a chamada refeita é o que separa os dois — a mesma iteração
 * das 21:21 leu 186 páginas distintas do arquivo, e página nova não conta.
 *
 * O preço disso é a deriva que nunca volta atrás: um `offset` estritamente
 * crescente não refaz chamada nenhuma e passa por fora. Não há como separá-la
 * da leitura paginada legítima com o que o log traz — a iteração das 21:21 é
 * exatamente uma caminhada dessas, e entregou.
 */
export const ORIENTATION_TARGET_LOOP_LIMIT = 25;

/**
 * Quantas vezes o processo principal pode repetir o mesmo `tool_use` antes de
 * o Ralph chamar aquilo de laço (issue #76). Teto próprio, e mais alto que os
 * 10 da Orientação, porque as duas fases fazem coisas diferentes: a iteração
 * que trabalha roda a mesma suíte e o mesmo `git status` de novo de forma
 * legítima, enquanto a Orientação lê e relata e não deveria repetir nada.
 *
 * Vinte fica no meio da folga medida nos 96 logs dos três repositórios alvo:
 * entre as 71 iterações que fecharam com `result: success`, a que mais repetiu
 * repetiu 6 vezes (um `Bash true`, 24/08/2026 20:26, 90 turnos e entrega), e o
 * menor laço do principal é 40 (a iteração das 20:30 de 28/08/2026, repetindo
 * um `find`). Os outros três laços repetiram 85, 85 e 43.
 *
 * A chave grossa da #75 — chamada refeita no mesmo alvo — não vale aqui: a
 * iteração que implementa relê e reescreve o mesmo arquivo o tempo todo, e o
 * alvo repetido é rotina dela, não sintoma. O preço é o laço que anda o
 * argumento passar batido no principal, como passava antes da #75 na
 * Orientação.
 */
export const MAIN_LOOP_LIMIT = 20;

export function createStreamRenderer({ onEvent } = {}) {
  const state = {
    text: "",
    thinking: "",
    finalResult: null,
    costUsd: 0,
    turns: 0,
    isError: false,
    sessionId: null,
    skills: null,
    mcpServers: null,
    modelUsage: null,
    subagentTokens: 0,
    orientationCalls: 0,
    orientationSummaries: 0,
    orientationDelegatedTo: null,
    failedSkills: [],
    stuckLoop: null,
  };

  // Ids dos `tool_use` do Agent tool. Sem isto, qualquer `tool_result` que
  // por acaso contenha o texto `subagent_tokens:` — a saída de um grep sobre
  // os próprios logs do Ralph, por exemplo — entrava na conta.
  const subagentCalls = new Set();

  // Ids das delegações síncronas ao subagente `orientation`: só o
  // `tool_result` delas pode trazer o resumo de orientação (issue #66).
  const orientationCallIds = new Set();

  // Id do `tool_use` da Skill -> nome pedido. A #72: o agente chamou a Skill
  // com o nome pelado, o harness recusou, e o passo do prompt sumiu sem
  // rastro no resumo. Só o `tool_result` sabe que falhou; só o `tool_use`
  // sabe qual skill era.
  const skillCalls = new Map();

  // Quantas vezes a Orientação pediu cada `tool_use` (issue #74). A chave é a
  // ferramenta mais o input inteiro: o laço do Provedor local repete a chamada
  // idêntica, e é isso que o distingue da Orientação que lê muita coisa.
  //
  // Contagem acumulada, não consecutiva: a iteração das 20:03 de 28/08/2026
  // alternava as issues 18, 19 e 20 em ciclo de período 3 — nenhuma repetição
  // era consecutiva, e ninguém saía do lugar do mesmo jeito.
  const orientationTools = new Map();

  // Quantas chamadas já feitas a Orientação refez em cada alvo (issue #75). A
  // chave é a ferramenta mais o alvo — o `detail` que a linha do stream já
  // mostra —, e só entra a chamada cujo input inteiro repete um anterior: ler
  // uma página nova do mesmo arquivo não conta, e é isso que deixa a leitura
  // paginada legítima passar.
  const orientationTargets = new Map();

  // A mesma conta para o processo principal (issue #76), em mapa separado: o
  // laço de 01/09/2026 repetiu `git log --oneline -5` 43 vezes fora da
  // Orientação, e a #74 só media a delegação. Somar as duas fases num mapa só
  // misturaria o comando que a Orientação leu com o que o principal rodou.
  const mainTools = new Map();

  // A chave da chamada repetida: ferramenta mais input inteiro. Uma função
  // para as duas fases, porque contar diferente em cada uma faria os dois
  // tetos medirem coisas diferentes com o mesmo nome.
  function sameInputKey(block) {
    return `${block.name}
${JSON.stringify(block.input ?? {})}`;
  }

  function countOrientationTool(block, detail) {
    const key = sameInputKey(block);
    const count = (orientationTools.get(key) ?? 0) + 1;
    orientationTools.set(key, count);
    if (count >= ORIENTATION_LOOP_LIMIT) {
      recordLoop({ phase: "orientation", kind: "same-input", tool: block.name, detail, count });
      return;
    }
    // Sem `detail` o alvo seria a ferramenta pelada, e aí todo `Read` da
    // iteração viraria um alvo só.
    if (count === 1 || !detail) return;
    const targetKey = `${block.name}
${detail}`;
    const redone = (orientationTargets.get(targetKey) ?? 0) + 1;
    orientationTargets.set(targetKey, redone);
    if (redone >= ORIENTATION_TARGET_LOOP_LIMIT) {
      recordLoop({ phase: "orientation", kind: "same-target", tool: block.name, detail, count: redone });
    }
  }

  function countMainTool(block, detail) {
    const key = sameInputKey(block);
    const count = (mainTools.get(key) ?? 0) + 1;
    mainTools.set(key, count);
    if (count >= MAIN_LOOP_LIMIT) recordLoop({ phase: "main", kind: "same-input", tool: block.name, detail, count });
  }

  /**
   * O pior comando responde pela iteração (issue #74): reportar o primeiro a
   * estourar esconderia o que de fato dominou o laço. A comparação é dentro do
   * mesmo `kind`, porque as duas contagens não medem a mesma coisa — uma é
   * repetição de uma chamada, a outra é chamada refeita num alvo — e o teto
   * fino ganha do grosso: quem repete `gh issue view 16` merece ler isso, e
   * não "refez 25 chamadas de Bash".
   *
   * Nada disso seria alcançável se o `abortWhen` de `runClaudeStreaming`
   * cortasse na primeira detecção, mas ele roda depois de cada chunk, e um
   * chunk traz vários `tool_use`.
   */
  function recordLoop(loop) {
    const current = state.stuckLoop;
    // A fase que travou primeiro responde pela iteração (issue #76): o laço do
    // principal atrás de um da Orientação é consequência, e trocar a linha
    // mandaria o operador consertar o modelo errado.
    if (current && current.phase !== loop.phase) return;
    if (current?.kind === "same-input" && loop.kind !== "same-input") return;
    if (current?.kind === loop.kind && loop.count <= current.count) return;
    state.stuckLoop = loop;
  }

  function handle(evt) {
    onEvent?.(evt);
    switch (evt.type) {
      case "system":
        if (evt.subtype === "init") {
          state.sessionId = evt.session_id ?? null;
          if (evt.skills !== undefined) state.skills = evt.skills;
          if (evt.mcp_servers !== undefined) state.mcpServers = evt.mcp_servers;
          const tools = Array.isArray(evt.tools) ? evt.tools.length : "?";
          const skills = Array.isArray(evt.skills) ? evt.skills.length : null;
          process.stdout.write(
            paint(C.dim, `  sessão ${String(evt.session_id).slice(0, 8)} · modelo ${evt.model ?? "?"} · ${tools} ferramentas${skills !== null ? ` · ${skills} skills` : ""}\n\n`)
          );
        }
        break;

      case "assistant": {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            state.text += block.text;
            process.stdout.write(block.text.replace(/\n/g, "\n") + "\n\n");
          } else if (block.type === "tool_use") {
            if (block.name === "Agent" || block.name === "Task") {
              subagentCalls.add(block.id);
              // Só a Orientação entra na conta: o Claude Code dispara o Agent
              // por conta própria 2 a 3 vezes por iteração (medido na #9), e
              // contar tudo faria o aviso do teto tocar em toda iteração.
              // Literal como `"Agent"` e `"Task"` acima — este módulo lê o
              // protocolo do CLI e não conhece o resto do Ralph; importar o
              // nome de `orientation.mjs` arrastaria Docker e fs para cá.
              // Conta o `tool_use`, não a execução: o teto do ADR-0004 proíbe
              // pedir a Orientação de novo, mesmo que a primeira tenha falhado.
              //
              // A quem a Orientação foi delegada (issue #66): a chamada a
              // `orientation` vence de qualquer ponto da iteração, e só na
              // falta dela a primeira delegação responde pelo passo 1. Sem a
              // primeira regra, o `Explore` que o Claude Code dispara sozinho
              // antes do passo 1 levaria a culpa; sem a segunda, a delegação
              // que trocou o `subagent_type` não teria quem a nomeasse.
              const subagentType = block.input?.subagent_type;
              if (subagentType === "orientation") {
                state.orientationDelegatedTo = "orientation";
                state.orientationCalls += 1;
                // `run_in_background: true` devolve "Async agent launched
                // successfully" no lugar do resumo (issue #65), e o recibo
                // volta sem erro. Contá-lo calaria o aviso justamente na
                // regressão que a #65 acabou de consertar.
                if (block.input?.run_in_background !== true) orientationCallIds.add(block.id);
              } else if (state.orientationDelegatedTo === null && typeof subagentType === "string") {
                state.orientationDelegatedTo = subagentType;
              }
            } else if (block.name === "Skill" && typeof block.input?.skill === "string") {
              skillCalls.set(block.id, block.input.skill);
            }
            const detail = describeTool(block.name, block.input);
            if (evt.subagent_type === "orientation") countOrientationTool(block, detail);
            // Sem `subagent_type` é o processo principal (issue #76). Os
            // outros subagentes ficam de fora — o `general-purpose` que o
            // agente delega por conta própria aparece em log real com 15
            // eventos numa iteração só, e o que ele repete lá dentro é o
            // trabalho dele, não a iteração parada.
            else if (!evt.subagent_type) countMainTool(block, detail);
            process.stdout.write(
              `${paint(C.cyan, "⚙")} ${paint(C.bold, block.name)}${detail ? paint(C.dim, "  " + detail) : ""}\n`
            );
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            // Só o raciocínio do processo principal entra no que `foundPromise`
            // lê (issue #70): quem foi mandado emitir a promise é a iteração, e
            // nenhum subagente fala por ela. O da Orientação porque o prompt
            // dela cita a promise justamente para dizer que emiti-la não é
            // papel dela; o do `general-purpose` que o agente delega sozinho
            // porque ele nem viu o passo 2 do prompt da iteração.
            if (!evt.subagent_type) state.thinking += block.thinking + "\n";
            const preview = block.thinking.trim().split("\n")[0].slice(0, 100);
            process.stdout.write(paint(C.dim, `  ⋯ ${preview}\n`));
          }
        }
        break;
      }

      case "user": {
        for (const block of evt.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const body = typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c) => c.text ?? "").join(" ");
          if (block.is_error) {
            process.stdout.write(paint(C.red, `  ✗ ${body.split("\n")[0].slice(0, 160)}\n`));
            const skill = skillCalls.get(block.tool_use_id);
            // Uma linha por skill: retentar a mesma skill e falhar de novo é
            // um passo perdido, não dois.
            if (skill && !state.failedSkills.includes(skill)) state.failedSkills.push(skill);
          } else {
            const skill = skillCalls.get(block.tool_use_id);
            // O agente que erra o nome e acerta na segunda contornou sozinho —
            // o passo rodou, e avisar aqui seria mentira. O nome pelado é o
            // sufixo do qualificado (`code-review` em `plugin:code-review`),
            // que é justamente o erro da #72, então comparar pelo sufixo é o
            // que reconhece o acerto.
            if (skill) state.failedSkills = state.failedSkills.filter((f) => baseSkillName(f) !== baseSkillName(skill));
          }
          // Resumo é o `tool_result` sem erro que traz a linha `STATUS:` do
          // contrato de `prompts/orientation.md`. A delegação que reprovou na
          // validação, e a que voltou com "hit an output limit" no lugar do
          // resumo (a iteração das 14:42 de 28/08/2026, na issue #66), não
          // orientaram ninguém — e a segunda volta sem `is_error`.
          if (orientationCallIds.has(block.tool_use_id) && !block.is_error && /^STATUS:/m.test(body)) {
            state.orientationSummaries += 1;
          }
          if (subagentCalls.has(block.tool_use_id)) {
            const tokens = parseSubagentTokens(body);
            if (tokens !== null) state.subagentTokens += tokens;
          }
        }
        break;
      }

      case "result": {
        state.finalResult = evt.result ?? state.text;
        state.costUsd = evt.total_cost_usd ?? 0;
        state.turns = evt.num_turns ?? 0;
        state.isError = evt.is_error === true || evt.subtype !== "success";
        state.modelUsage = evt.modelUsage ?? null;
        const secs = ((evt.duration_ms ?? 0) / 1000).toFixed(0);
        const cost = state.costUsd ? `$${state.costUsd.toFixed(4)}` : "—";
        process.stdout.write(
          paint(C.dim, `\n  ${state.turns} turnos · ${secs}s · ${cost}\n`)
        );
        break;
      }
    }
  }

  /** Alimenta o renderizador com um pedaço bruto de stdout do claude. */
  let buffer = "";
  function write(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* linha JSON truncada ou ruído: ignora, como o `grep '^{'` do artigo */
      }
    }
  }

  function end() {
    const line = buffer.trim();
    buffer = "";
    if (line.startsWith("{")) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* idem */
      }
    }
    return state;
  }

  return { write, end, state };
}

/**
 * Procura <promise>VALOR</promise> no texto produzido pela iteração.
 *
 * `includeThinking` estende a busca ao raciocínio, e entra por medição (issue
 * #70): em 01/09/2026, num alvo sem issue tracker, `ornith:9b` recebeu
 * `STATUS: blocked` da Orientação, escreveu "I should emit
 * `<promise>BLOCKED</promise>` with a clear explanation" enquanto pensava, e
 * devolveu um texto final sem a tag. `runLoop` não achou a promise, e um
 * `ralph afk` ali queimaria o teto de iterações inteiro reencontrando o mesmo
 * repositório vazio.
 *
 * É o oposto da decisão do canário (issue #64), que lê só o texto de propósito,
 * e as duas estão certas: lá o modelo cita as duas senhas enquanto pensa, e
 * aceitar isso apagaria a distinção que a prova faz; aqui a tag é literal e só
 * quem foi mandado emiti-la a escreve.
 *
 * Opcional, e não ligado sozinho, porque o preço das duas promises é diferente.
 * O passo 2 de `prompts/implement.md` lista as duas tags, então o modelo que
 * recita o passo enquanto pensa escreve as duas: aceitar `COMPLETE` do
 * raciocínio fecharia a noite com "backlog concluído" sobre um backlog cheio,
 * e ninguém vai conferir de manhã o que saiu como sucesso. Um `BLOCKED` a mais
 * para cedo custa uma iteração e chama o humano, que é o desfecho que ele
 * pede de qualquer jeito. Quem liga é `runIteration`, na promise de bloqueio.
 */
export function foundPromise(state, promise, { includeThinking = false } = {}) {
  const thinking = includeThinking ? `\n${state.thinking}` : "";
  const haystack = `${state.text}${thinking}\n${state.finalResult ?? ""}`;
  return haystack.includes(`<promise>${promise}</promise>`);
}

/**
 * O Agent tool devolve `subagent_tokens` num bloco `<usage>` de texto solto
 * dentro do `tool_result`, não como campo estruturado — não há outro jeito
 * de ler o que um subagente consumiu.
 */
function parseSubagentTokens(text) {
  const m = /subagent_tokens:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** O nome canônico carrega versão e data (`claude-haiku-4-5-20251001`); o relatório final só precisa da família. */
function shortModelName(canonicalModel) {
  const m = /^claude-([a-z]+)/i.exec(canonicalModel);
  return m ? m[1].toLowerCase() : canonicalModel;
}

/**
 * Silêncio quando o teto é respeitado (issue #15). A versão anterior imprimia
 * os tokens de subagente em toda iteração, e um número que aparece sempre não
 * distingue a iteração que destoou — que é a única razão de olhar a linha. Os
 * tokens continuam no resumo do loop, acumulados.
 */
export function formatOrientationWarning(orientationCalls) {
  if (orientationCalls <= 1) return "";
  return `⚠ ${orientationCalls} orientações nesta iteração — o teto é uma (ADR-0004)`;
}

/**
 * A iteração que não recebeu resumo de orientação nenhum orientou-se sozinha,
 * e o resumo dela fechava verde sobre isso (issue #66). Duas iterações reais
 * contra `ornith:9b` em 28/08/2026, dois avisos:
 *
 * - 14:12 — delegou para `orientation`, o resumo nunca voltou, e o contexto
 *   principal releu o issue tracker, dois ADRs e três arquivos. É o custo que
 *   o ADR-0004 existe para não pagar.
 * - 14:42 — a delegação saiu com `subagent_type: "general-purpose"`. Some a
 *   whitelist que segura "quem orienta não escreve" e some o
 *   `orientationModel` do config; o Ralph injeta o agente por `--agents` e
 *   não percebia que ele foi descartado.
 *
 * Exclusivos de propósito: quem leu o segundo já sabe que o primeiro vale, e
 * duas linhas amarelas para um desvio só é ruído. Resumo na mão devolve string
 * vazia — iteração saudável não ganha linha nenhuma.
 */
export function formatOrientationMissWarning(orientationSummaries, delegatedTo) {
  if (orientationSummaries > 0) return "";
  if (delegatedTo && delegatedTo !== "orientation") {
    return `⚠ a Orientação foi delegada a '${delegatedTo}', não a orientation — sem a whitelist do ADR-0004 e com o orientationModel do config ignorado`;
  }
  return "⚠ nenhum resumo de orientação chegou do subagente — a Orientação rodou no contexto principal (ADR-0004)";
}

/** `mattpocock-skills:code-review` e `code-review` são a mesma skill pedida de dois jeitos. */
function baseSkillName(skill) {
  return skill.slice(skill.lastIndexOf(":") + 1);
}

/**
 * A tool que falha e o agente contorna sozinho é rotina; a Skill que falha
 * não tem contorno — o passo do prompt que dependia dela simplesmente não
 * aconteceu, e o commit sai como se tivesse acontecido (issue #72). Por isso
 * só a Skill vira aviso, e não a contagem geral de `tool_result` com erro:
 * 43 iterações de log real deram 59 erros de tool, nenhum deles de Skill —
 * o contador geral tocaria em toda iteração sem dizer nada.
 */
export function formatSkillFailureWarning(failedSkills) {
  if (!failedSkills?.length) return "";
  return `⚠ a tool Skill falhou: ${failedSkills.join(", ")} — o passo do prompt que dependia dela não rodou`;
}

/**
 * Pura para ser testável sem Docker (issue #9) — espelha o `cost +=` que
 * `runLoop` já faz, mas por modelo. `modelUsage` ausente (iteração que não
 * chegou a reportar custo) devolve `totals` intacto em vez de zerar o loop.
 */
export function accumulateModelUsage(totals, modelUsage) {
  if (!modelUsage) return totals;
  const next = { ...totals };
  for (const [model, usage] of Object.entries(modelUsage)) {
    next[model] = (next[model] ?? 0) + (usage.costUSD ?? 0);
  }
  return next;
}

/**
 * `$X` com um modelo só — idêntico ao relatório de antes desta feature —
 * ou `$X (modelo $Y · modelo $Z)` com mais de um. Pura.
 *
 * `billed: false` é o Provedor que não cobra, e aí nem se olha o total: o CLI
 * reporta `total_cost_usd` mesmo com o Ollama, porque marca `provider:
 * "firstParty"` no `modelUsage` e aplica a tabela de preço da Anthropic sobre
 * tokens locais. Foi assim que uma noite contra `ornith:9b` fechou em
 * US$ 115,83 sem uma inferência ter saído da máquina (issue #68).
 */
export function formatCostByModel(totalCost, modelTotals, { billed = true, fallback = "—" } = {}) {
  if (!billed) return fallback;
  const models = Object.keys(modelTotals ?? {});
  // `result` pode trazer `modelUsage` e não trazer `total_cost_usd`. Jogar a
  // quebra fora nesse caso é o desperdício que a issue #9 veio consertar:
  // o dado chegou, então a soma dele é o total.
  const total = totalCost || models.reduce((acc, m) => acc + modelTotals[m], 0);
  if (!total) return fallback;
  const cost = `$${total.toFixed(4)}`;
  if (models.length <= 1) return cost;
  const breakdown = models.map((m) => `${shortModelName(m)} $${modelTotals[m].toFixed(4)}`).join(" · ");
  return `${cost} (${breakdown})`;
}

export { C as colors, paint };

/**
 * Puro: a linha que o operador lê quando a iteração travou em laço. Diz o
 * comando, porque é ele que identifica onde o modelo parou de decidir — nas
 * quatro iterações da #74 era sempre um `gh issue view` reconsultando o estado
 * de um ticket que a Orientação já tinha lido, e no laço do principal de
 * 01/09/2026 era um `git log --oneline -5` que não tinha mudado de resposta.
 *
 * Quem travou aparece na linha (issue #76) porque é o que diz qual campo do
 * config muda o desfecho: a Orientação sai por `orientationModel`, a iteração
 * inteira sai por `model`.
 */
export function formatStuckLoop(loop) {
  if (!loop) return "";
  const detail = loop.detail ? ` (${loop.detail})` : "";
  const who = loop.phase === "main" ? "o processo principal" : "a Orientação";
  if (loop.kind === "same-target") {
    return `${who} refez ${loop.count} chamadas de ${loop.tool}${detail} que já tinha feito — laço fechado`;
  }
  return `${who} repetiu ${loop.count}x o mesmo ${loop.tool}${detail} — laço fechado`;
}
