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
