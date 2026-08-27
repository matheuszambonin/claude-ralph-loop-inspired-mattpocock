import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ralphHome } from "./paths.mjs";

/**
 * Os prompts que dirigem uma Iteração inteira. Conjunto declarado, não
 * `readdir` em `prompts/`: `orientation.md` mora no mesmo diretório e é prompt
 * de subagente — até a issue #48, `ralph init --prompt orientation` o instalava
 * como Prompt da iteração sem uma palavra.
 */
export const ITERATION_PROMPTS = ["implement", "entropy", "test-coverage"];

/** O que o `init` instala quando ninguém — nem a flag, nem o arquivo — diz qual. */
export const DEFAULT_PROMPT = "implement";

/** Os outros. O primeiro é o exemplo que as mensagens citam quando precisam de um nome real. */
export const OTHER_PROMPTS = ITERATION_PROMPTS.filter((name) => name !== DEFAULT_PROMPT);

/** O valor que o operador escreve no cabeçalho para assumir o arquivo. */
export const CUSTOM = "custom";

/**
 * A linha de procedência que cada template de iteração carrega. A cópia feita
 * pelo `init` a herda de graça, então o arquivo instalado continua byte a byte
 * idêntico ao template: procedência e prova de fidelidade viram a mesma
 * comparação (ADR-0009).
 *
 * Não é lida só na linha 1 porque `implement.md` precisa abrir com a invocação
 * da skill — um comentário antes dela faria o `claude -p` receber um prompt que
 * não começa com `/`, e a skill não carregaria. Casa a linha inteira, então
 * prosa que mencione o marcador de passagem não vira procedência.
 */
const PROVENANCE = /^<!--\s*ralph:prompt\s+([A-Za-z0-9_.-]+)\s*-->\s*$/;

/** O nome de template que o próprio arquivo declara, ou `null` se ele não declara nenhum. */
export function readProvenance(text) {
  for (const line of text.split("\n")) {
    const m = PROVENANCE.exec(line.replace(/\r$/, ""));
    if (m) return m[1];
  }
  return null;
}

/**
 * `.ralph/prompt.md` é commitado no repositório alvo e `.gitattributes` costuma
 * marcar `*.md text` sem `eol=lf` — sem normalizar, um clone no Windows acusaria
 * deriva onde só houve checkout.
 */
const sameText = (a, b) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * Pura: o texto do prompt instalado e os templates de iteração entram como
 * dado, o estado sai. Não lê arquivo, não conhece caminho, não conhece config.
 *
 * Nunca adivinha a origem de um prompt sem cabeçalho: casar por similaridade
 * trocaria um loop de entropia por um de implement em silêncio, desfecho pior
 * que a deriva.
 */
export function checkDrift(installedText, templates) {
  const declared = readProvenance(installedText);
  if (!declared) return { state: "sem-procedencia", template: null };
  if (declared === CUSTOM) return { state: "custom", template: null };

  // Cabeçalho que aponta pra um template que este Ralph não distribui não dá o
  // que re-sincronizar — mesmo veredito de quem não tem cabeçalho, mas o nome
  // declarado sobrevive para a mensagem não dizer que o arquivo calou.
  const template = templates[declared];
  if (template === undefined) return { state: "sem-procedencia", template: null, declared };

  return sameText(installedText, template)
    ? { state: "em-dia", template: declared }
    : { state: "deriva", template: declared };
}

/**
 * O veredito em texto. Nunca reprova: prompt em deriva ainda roda, e recusar a
 * iteração por causa dele custaria mais que o atraso que ele carrega.
 */
export function describeDrift(check, promptFile) {
  switch (check.state) {
    case "em-dia":
      return { level: "ok", message: `${promptFile} em dia com o template '${check.template}'` };
    case "custom":
      return { level: "ok", message: `${promptFile} é seu (${CUSTOM}) — o Ralph não o re-sincroniza` };
    case "deriva":
      return {
        level: "warn",
        message:
          `${promptFile} divergiu do template '${check.template}' — 'ralph once' e 'ralph afk' ` +
          `re-sincronizam antes da próxima iteração; 'ralph init --force' faz agora`,
      };
    default:
      return {
        level: "warn",
        message:
          (check.declared
            ? `${promptFile} veio do template '${check.declared}', que este Ralph não distribui.`
            : `${promptFile} não diz de qual template veio, e o Ralph não adivinha.`) + provenancePaths(),
      };
  }
}

/**
 * Os três caminhos de um prompt sem procedência, um por linha, cada comando
 * colável como está.
 *
 * Nada de `--prompt <a|b|c>`: no PowerShell `<` e `>` são operadores reservados,
 * e a linha morria no parser antes de virar comando; quem tirava os sinais e
 * deixava `--prompt` pelado caía em `'true' não é um prompt de iteração`, porque
 * a flag sem valor vira `true` (issue #50).
 *
 * O padrão vem nomeado porque `ralph init --force`, sem `--prompt` nenhum, já
 * resolve o aviso — a mensagem antiga pedia a flag como se fosse obrigatória.
 */
function provenancePaths() {
  const [example, ...rest] = OTHER_PROMPTS;
  const column = (text) => text.padEnd(38); // onde o parêntese de cada linha começa
  return (
    `\n  Padrão:    ${column("ralph init --force")}(instala o ${DEFAULT_PROMPT})` +
    `\n  Outro:     ${column(`ralph init --force --prompt ${example}`)}(ou ${rest.join(", ")})` +
    `\n  Já é seu:  ponha '<!-- ralph:prompt ${CUSTOM} -->' numa linha do topo do arquivo`
  );
}

/**
 * Qual template o `ralph init` instala. Pura: o pedido do operador e o estado
 * do prompt que já está lá entram, a escolha sai.
 *
 * Sem `--prompt`, `--force` re-sincroniza o template que o arquivo declara, não
 * o padrão: num alvo rodando `entropy`, cair no `implement` trocaria o loop em
 * silêncio — o mesmo desfecho que o ADR-0009 recusa quando rejeita adivinhar a
 * origem por similaridade. E arquivo que o operador reivindicou (`custom`) só
 * é sobrescrito por um `--prompt` explícito.
 */
export function chooseTemplate(requested, installed) {
  if (requested) return { name: requested, install: true };
  if (installed?.state === CUSTOM) return { name: null, install: false };
  return { name: installed?.template ?? DEFAULT_PROMPT, install: true };
}

export function templatePath(name) {
  return path.join(ralphHome(), "prompts", `${name}.md`);
}

/** Os templates de iteração distribuídos com esta cópia do Ralph, por nome. */
export function readIterationTemplates() {
  const templates = {};
  for (const name of ITERATION_PROMPTS) {
    const file = templatePath(name);
    if (existsSync(file)) templates[name] = readFileSync(file, "utf8");
  }
  return templates;
}

/** O estado do prompt instalado no repo alvo, ou `null` se não há prompt instalado. */
export function inspectPrompt(root, cfg) {
  const file = path.join(root, cfg.promptFile);
  if (!existsSync(file)) return null;
  return checkDrift(readFileSync(file, "utf8"), readIterationTemplates());
}

export function installPrompt(root, cfg, name) {
  const dst = path.join(root, cfg.promptFile);
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(templatePath(name), dst);
  return dst;
}

/**
 * Chamado uma vez antes do loop, com o prompt que todas as iterações vão
 * receber: deriva é atraso, não escolha, então o único desfecho útil é
 * desfazê-la. `custom` e `sem-procedencia` só relatam — em nenhum dos dois o
 * Ralph sabe o que reinstalar sem apagar decisão de alguém.
 */
export function ensurePromptFresh(root, cfg) {
  const check = inspectPrompt(root, cfg);
  if (!check) return null;
  if (check.state !== "deriva") return { ...check, resynced: false };
  installPrompt(root, cfg, check.template);
  return { ...check, resynced: true };
}
