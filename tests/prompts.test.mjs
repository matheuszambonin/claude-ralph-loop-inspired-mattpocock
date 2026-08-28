import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ITERATION_PROMPTS,
  DEFAULT_PROMPT,
  CUSTOM,
  readProvenance,
  checkDrift,
  chooseTemplate,
  describeDrift,
  readIterationTemplates,
  ensurePromptFresh,
} from "../src/prompts.mjs";
import { ralphHome } from "../src/paths.mjs";

function tmpRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ralph-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePrompt(root, text) {
  mkdirSync(path.join(root, ".ralph"), { recursive: true });
  writeFileSync(path.join(root, ".ralph", "prompt.md"), text, "utf8");
}

const cfg = { promptFile: ".ralph/prompt.md" };
const TEMPLATES = { implement: "<!-- ralph:prompt implement -->\ncorpo do implement\n", entropy: "<!-- ralph:prompt entropy -->\ncorpo do entropy\n" };

/**
 * O prompt que rodou durante quase toda a conta de US$ 109,75 medida na issue
 * #48: nenhum cabeçalho, nenhuma menção ao subagente. É o formato de todo
 * `.ralph/prompt.md` que existe hoje em disco.
 */
const PRE_ADR0004 = "/mattpocock-skills:implement\n\nYou are ONE iteration of a Ralph loop.\n";

// ------------------------------------------------------------ readProvenance --
test("readProvenance: cabeçalho na primeira linha devolve o nome do template", () => {
  assert.equal(readProvenance("<!-- ralph:prompt entropy -->\ncorpo\n"), "entropy");
});

test("readProvenance: cabeçalho abaixo da invocação da skill continua valendo", () => {
  assert.equal(readProvenance("/mattpocock-skills:implement\n<!-- ralph:prompt implement -->\ncorpo\n"), "implement");
});

test("readProvenance: sem cabeçalho devolve null", () => {
  assert.equal(readProvenance(PRE_ADR0004), null);
});

// ----------------------------------------------------------------- checkDrift --
test("checkDrift: cópia fiel do template é em-dia", () => {
  assert.deepEqual(checkDrift(TEMPLATES.implement, TEMPLATES), { state: "em-dia", template: "implement" });
});

test("checkDrift: só o EOL diferente continua em-dia — checkout no Windows não é deriva", () => {
  const crlf = TEMPLATES.implement.replace(/\n/g, "\r\n");
  assert.equal(checkDrift(crlf, TEMPLATES).state, "em-dia");
});

test("checkDrift: conteúdo divergente do template que o cabeçalho declara é deriva", () => {
  const stale = "<!-- ralph:prompt implement -->\ncorpo velho\n";
  assert.deepEqual(checkDrift(stale, TEMPLATES), { state: "deriva", template: "implement" });
});

test("checkDrift: cabeçalho custom é custom mesmo divergindo de tudo", () => {
  assert.deepEqual(checkDrift(`<!-- ralph:prompt ${CUSTOM} -->\nqualquer coisa\n`, TEMPLATES), {
    state: "custom",
    template: null,
  });
});

test("checkDrift: prompt sem cabeçalho é sem-procedencia — o estado de todo repo alvo de hoje", () => {
  assert.deepEqual(checkDrift(PRE_ADR0004, TEMPLATES), { state: "sem-procedencia", template: null });
});

test("checkDrift: cabeçalho apontando pra template que este Ralph não distribui não dá o que re-sincronizar", () => {
  assert.equal(checkDrift("<!-- ralph:prompt inventado -->\ncorpo\n", TEMPLATES).state, "sem-procedencia");
});

// -------------------------------------------------------------- describeDrift --
test("describeDrift: em-dia e custom passam verde", () => {
  assert.equal(describeDrift({ state: "em-dia", template: "implement" }, ".ralph/prompt.md").level, "ok");
  assert.equal(describeDrift({ state: "custom", template: null }, ".ralph/prompt.md").level, "ok");
});

test("describeDrift: deriva avisa e nomeia o template", () => {
  const { level, message } = describeDrift({ state: "deriva", template: "entropy" }, ".ralph/prompt.md");
  assert.equal(level, "warn");
  assert.match(message, /entropy/);
});

test("describeDrift: sem-procedencia lista os templates e o jeito de assumir o arquivo", () => {
  const { level, message } = describeDrift({ state: "sem-procedencia", template: null }, ".ralph/prompt.md");
  assert.equal(level, "warn");
  for (const name of ITERATION_PROMPTS) assert.match(message, new RegExp(name));
  assert.match(message, /custom/);
});

test("describeDrift: sem-procedencia nomeia o padrão e o comando sem flag que o instala", () => {
  const { message } = describeDrift({ state: "sem-procedencia", template: null }, ".ralph/prompt.md");
  assert.match(message, new RegExp(`ralph init --force\\s+\\(instala o ${DEFAULT_PROMPT}\\)`));
});

/**
 * As linhas que o operador cola no shell. O marcador `<!-- ralph:prompt custom -->`
 * fica de fora de propósito — ele não é comando, é o texto que vai para dentro do
 * arquivo; `ralph:prompt` não tem espaço depois de `ralph`, e é isso que o separa.
 */
const shellLines = (message) => message.split("\n").filter((l) => /ralph /.test(l));

test("describeDrift: nenhum comando do aviso tem '<' ou '>' — cola no PowerShell sem editar", () => {
  for (const state of ["sem-procedencia", "deriva"]) {
    const { message } = describeDrift({ state, template: "entropy" }, ".ralph/prompt.md");
    const commands = shellLines(message);
    assert.ok(commands.length > 0, `o aviso de ${state} não sugere comando nenhum`);
    for (const line of commands) assert.doesNotMatch(line, /[<>]/);
  }
});

// ------------------------------------------------------- templates distribuídos --
test("readIterationTemplates: os três templates de iteração declaram a própria procedência", () => {
  const templates = readIterationTemplates();
  assert.deepEqual(Object.keys(templates).sort(), [...ITERATION_PROMPTS].sort());
  for (const [name, text] of Object.entries(templates)) assert.equal(readProvenance(text), name);
});

test("readIterationTemplates: orientation não entra — é prompt de subagente, não de iteração", () => {
  assert.equal(readIterationTemplates().orientation, undefined);
  const orientation = readFileSync(path.join(ralphHome(), "prompts", "orientation.md"), "utf8");
  assert.equal(readProvenance(orientation), null);
});

// ----------------------------------------------------------- ensurePromptFresh --
test("ensurePromptFresh: deriva reinstala o template e diz qual foi", (t) => {
  const root = tmpRepo(t);
  writePrompt(root, "<!-- ralph:prompt entropy -->\ncorpo velho\n");
  const result = ensurePromptFresh(root, cfg);
  assert.equal(result.state, "deriva");
  assert.equal(result.template, "entropy");
  assert.equal(result.resynced, true);
  assert.equal(
    readFileSync(path.join(root, ".ralph", "prompt.md"), "utf8"),
    readFileSync(path.join(ralphHome(), "prompts", "entropy.md"), "utf8")
  );
});

test("ensurePromptFresh: custom nunca é sobrescrito", (t) => {
  const root = tmpRepo(t);
  const mine = `<!-- ralph:prompt ${CUSTOM} -->\nprompt do operador\n`;
  writePrompt(root, mine);
  const result = ensurePromptFresh(root, cfg);
  assert.equal(result.state, "custom");
  assert.equal(result.resynced, false);
  assert.equal(readFileSync(path.join(root, ".ralph", "prompt.md"), "utf8"), mine);
});

test("ensurePromptFresh: sem-procedencia avisa sem adivinhar a origem", (t) => {
  const root = tmpRepo(t);
  writePrompt(root, PRE_ADR0004);
  const result = ensurePromptFresh(root, cfg);
  assert.equal(result.state, "sem-procedencia");
  assert.equal(result.resynced, false);
  assert.equal(readFileSync(path.join(root, ".ralph", "prompt.md"), "utf8"), PRE_ADR0004);
});

test("ensurePromptFresh: sem prompt no repo não inventa arquivo — quem cobra isso é o 'ralph init'", (t) => {
  const root = tmpRepo(t);
  assert.equal(ensurePromptFresh(root, cfg), null);
  assert.equal(existsSync(path.join(root, ".ralph", "prompt.md")), false);
});

test("ITERATION_PROMPTS: orientation não é prompt de iteração — 'ralph init --prompt orientation' precisa recusar", () => {
  assert.equal(ITERATION_PROMPTS.includes("orientation"), false);
  assert.deepEqual(ITERATION_PROMPTS, ["implement", "entropy", "test-coverage"]);
});

// -------------------------------------------------------------- chooseTemplate --
test("chooseTemplate: --prompt explícito vence o que já está instalado", () => {
  assert.deepEqual(chooseTemplate("entropy", { state: "em-dia", template: "implement" }), { name: "entropy", install: true });
});

test("chooseTemplate: --force sem --prompt re-sincroniza o template instalado, não o padrão", () => {
  assert.deepEqual(chooseTemplate(undefined, { state: "deriva", template: "entropy" }), { name: "entropy", install: true });
});

test("chooseTemplate: repo sem prompt nenhum cai no implement", () => {
  assert.deepEqual(chooseTemplate(undefined, null), { name: "implement", install: true });
});

test("chooseTemplate: custom só é sobrescrito por --prompt explícito", () => {
  assert.deepEqual(chooseTemplate(undefined, { state: CUSTOM, template: null }), { name: null, install: false });
  assert.deepEqual(chooseTemplate("implement", { state: CUSTOM, template: null }), { name: "implement", install: true });
});

test("chooseTemplate: sem procedência não vira entropy por acidente — cai no padrão", () => {
  assert.deepEqual(chooseTemplate(undefined, { state: "sem-procedencia", template: null }), { name: "implement", install: true });
});

test("describeDrift: cabeçalho de template que este Ralph não distribui não diz que o arquivo calou", () => {
  const check = checkDrift("<!-- ralph:prompt inventado -->\ncorpo\n", TEMPLATES);
  const { message } = describeDrift(check, ".ralph/prompt.md");
  assert.match(message, /inventado/);
});

/**
 * A regressão da issue #65: `implement.md` mandava usar a ferramenta `Agent`,
 * que o evento `init` da sessão no sandbox não anuncia — ele anuncia `Task` —
 * e a chamada lançava o subagente em background, devolvendo um recibo no lugar
 * do relatório. Três rodadas noturnas contra `ornith:9b` terminaram com a
 * iteração orientando a si mesma, o oposto do que o ADR-0004 compra.
 */
test("implement.md: delega pela ferramenta que a sessão anuncia, e delega síncrono", () => {
  const implement = readIterationTemplates().implement;
  assert.match(implement, /`Task` tool/);
  assert.doesNotMatch(implement, /\bAgent tool\b/);
  // Os dois campos que a chamada de 28/08/2026 perdeu, um em cada rodada: sem
  // `run_in_background: false` volta o recibo de lançamento, e sem
  // `description` a chamada reprova com InputValidationError.
  assert.match(implement, /`run_in_background: false`/);
  assert.match(implement, /`description: "orient"`/);
});

/**
 * A regressão da issue #73: o passo 2 mandava reivindicar o ticket "following
 * `docs/agents/issue-tracker.md`", e a indireção não se pagava nem quando o
 * documento respondia. O do Terraços prescreve o comando na linha 113, sob
 * "Tomar"; medido em 28/08/2026 com esse documento inteiro no contexto, o
 * `ornith:9b` reivindicou em 0 de 8 rodadas — ele lê, volta a `gh issue view`
 * e `gh issue list`, e reentra na órbita da Orientação. Com o comando chegando
 * pronto no resumo, 8/8. O `qwen3-coder:30b` falhava antes de ler: em 5 de 5
 * chamava `Task` com `subagent_type: "issue-tracker"`, que não existe.
 */
test("implement.md: reivindica com o comando que veio da Orientação, e não delega o claim", () => {
  const implement = readIterationTemplates().implement;
  // O rótulo no bloco de contrato: `checkOrientationContract` só prova que os
  // dois prompts batem entre si, então os dois podem perdê-lo juntos.
  assert.match(implement, /^CLAIM: /m);
  assert.match(implement, /run `CLAIM` with `Bash`/);
  // O outro lado da issue: com o passo 1 recém ensinando `subagent_type`, o
  // `qwen3-coder:30b` lia "issue-tracker" como agente e chamava `Task` com
  // `subagent_type: "issue-tracker"`, que não existe, em 5 de 5 rodadas.
  assert.match(implement, /`orientation` is\s+the only subagent that exists/);
});
