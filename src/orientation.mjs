import { readFileSync } from "node:fs";
import path from "node:path";
import { ralphHome } from "./paths.mjs";
import { detect as detectKnowledgeIndex, render as renderKnowledgeIndex, CRG_ID } from "./knowledge-index.mjs";

const AGENT_NAME = "orientation";

/**
 * Leitura, shell, busca por conteúdo e por caminho — nada de escrita. Quem
 * orienta não escreve (ADR-0004): `Bash` entra sem restrição de subcomando
 * porque medimos que restringir a um padrão não restringe nada — o subagente
 * recebe o shell inteiro de qualquer forma, e o issue tracker deste repo pode
 * exigir `gh`.
 */
const TOOL_WHITELIST = ["Read", "Grep", "Glob", "Bash"];

/** Lê o prompt do subagente do diretório de instalação do Ralph, não do repo alvo. */
export function readOrientationTemplate() {
  return readFileSync(path.join(ralphHome(), "prompts", "orientation.md"), "utf8");
}

/**
 * Pura: template e dado entram, prompt resolvido sai. O bloco do índice de
 * conhecimento migrou inteiro para cá (issue #10) — o placeholder saiu do
 * prompt da iteração porque só quem orienta precisa da instrução de consultar
 * o índice em vez de varrer arquivo.
 */
export function renderOrientationPrompt(template, cfg, promptBlock) {
  return template
    .replaceAll("{{PROGRESS_FILE}}", cfg.progressFile)
    .replaceAll("{{KNOWLEDGE_INDEX_BLOCK}}\n", promptBlock);
}

/** Lê o template do disco e resolve o bloco do índice de conhecimento do repo alvo. */
export function buildOrientationPrompt(root, cfg) {
  const { promptBlock } = renderKnowledgeIndex(detectKnowledgeIndex(root, cfg), null);
  return renderOrientationPrompt(readOrientationTemplate(), cfg, promptBlock);
}

/**
 * Pura: config e prompt entram, definição do subagente sai — sem Docker. É a
 * costura que a issue #10 pediu para o `--agents` da invocação: modelo vem do
 * config (`orientationModel`, default "haiku" — ver DEFAULTS em config.mjs) e a
 * whitelist é a garantia, testável aqui, de que quem orienta não escreve.
 *
 * `indexTools` são os nomes curtos que `render()` já filtrou pela sonda de
 * Ollama (issue #7) — nenhuma tool que a sonda derrubou chega aqui. Entram
 * qualificados como `mcp__<server>__<tool>`, a convenção que o `tools:` de um
 * subagente do Claude Code exige para tool de MCP.
 *
 * `model:` recebe a tag do Ollama sem apelido nenhum (issue #35: "aceita um
 * tag arbitrário, ou é preciso um apelido mapeado por ambiente?"). O lado que
 * dá pra provar sem Ollama de verdade (issue #34/#32: sem ele neste ambiente)
 * foi provado contra um sandbox de verdade: uma tag inválida em `--agents`
 * reprova com o mesmo erro de API (`model_not_found`, 404) que `--model <tag>`
 * já reprova hoje pro processo inteiro (issue #31) — a mesma forma de erro nos
 * dois casos é o sinal de que `--agents` não valida `model:` contra uma lista
 * fechada de apelidos do lado do cliente; ele só resolve `sonnet`/`opus`/
 * `haiku` antes de chamar a API, e deixa qualquer outra string passar direto,
 * exatamente como já faz para o processo inteiro. Que uma tag *válida* do
 * Ollama complete a chamada por esse mesmo caminho é inferência a partir desse
 * sinal, não observação direta — issue #31 já observou isso para o processo
 * inteiro, não para dentro de um subagente. Sob essa inferência, o desvio por
 * apelido (`ANTHROPIC_DEFAULT_HAIKU_MODEL` + `model: "haiku"`) que a spec
 * cogitava não é necessário.
 */
export function buildOrientationAgent(promptText, cfg, indexTools = []) {
  return {
    [AGENT_NAME]: {
      description:
        "Reads the issue tracker, PROGRESS.md and the project's docs to pick the next ticket for this iteration, without writing anything.",
      prompt: promptText,
      tools: [...TOOL_WHITELIST, ...indexTools.map((t) => `mcp__${CRG_ID}__${t}`)],
      model: cfg.orientationModel ?? "haiku",
    },
  };
}

/**
 * Mesma menção que faz a delegação acontecer de verdade (`prompts/implement.md`,
 * passo 1) — checar por ela é o único jeito de saber, a partir só do texto, que
 * um prompt de iteração depende do contrato da Orientação em vez de orientar
 * inline (issue #17).
 */
const DELEGATION_MARKER = 'subagent_type: "orientation"';

/**
 * O bloco de contrato é o primeiro cercado por crase que contém uma linha
 * `STATUS:` — os dois prompts distribuídos colam o mesmo bloco de exemplo, e é
 * dele que a iteração de fato lê os rótulos e os estados aceitos.
 */
function contractBlock(text) {
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (/^STATUS:/m.test(match[1])) return match[1];
  }
  return null;
}

/**
 * Rótulos na ordem em que aparecem (`STATUS`, `TICKET`, ...) e os estados que
 * `STATUS` aceita (`ready | complete | blocked`, o único rótulo com uma lista
 * fechada). Prosa depois dos dois-pontos não entra — é isso que deixa
 * reformatação inofensiva do bloco passar.
 */
function parseContract(block) {
  const labels = [];
  let states = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) continue;
    labels.push(m[1]);
    if (m[1] === "STATUS") states = m[2].split("|").map((s) => s.trim().split(/\s/)[0]).filter(Boolean);
  }
  return { labels, states };
}

/**
 * Pura (issue #17 / spec #16): recebe os dois textos como dado, não sabe de
 * onde vieram, e serve tanto ao teste que compara os dois prompts distribuídos
 * quanto ao `doctor` que compara o prompt do repo alvo com o template
 * instalado. Prompt de iteração que não menciona o subagente não tem contrato
 * a checar — `applicable: false`, nem passa nem reprova.
 */
export function checkOrientationContract(iterationPromptText, orientationTemplateText) {
  if (!iterationPromptText.includes(DELEGATION_MARKER)) return { applicable: false };

  const iterationBlock = contractBlock(iterationPromptText);
  const orientationBlock = contractBlock(orientationTemplateText);
  const iteration = iterationBlock ? parseContract(iterationBlock) : { labels: [], states: [] };
  const orientation = orientationBlock ? parseContract(orientationBlock) : { labels: [], states: [] };

  const issues = [];
  if (JSON.stringify(iteration.labels) !== JSON.stringify(orientation.labels)) {
    issues.push(`labels: iteration prompt expects [${iteration.labels.join(", ")}], orientation reports [${orientation.labels.join(", ")}]`);
  }
  const orientationStates = new Set(orientation.states);
  const iterationStates = new Set(iteration.states);
  const statesDiffer = iteration.states.some((s) => !orientationStates.has(s)) || orientation.states.some((s) => !iterationStates.has(s));
  if (statesDiffer) {
    issues.push(`states: iteration prompt accepts [${iteration.states.join(", ")}], orientation reports [${orientation.states.join(", ")}]`);
  }

  return { applicable: true, ok: issues.length === 0, issues };
}
