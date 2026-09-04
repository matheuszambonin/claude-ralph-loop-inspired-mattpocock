import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sandboxNameFor, dockerHostAddress } from "./paths.mjs";

export const DEFAULTS = {
  /** Modelo de cada iteração. Sonnet é o padrão: Ralph vive de muitas
   *  iterações baratas com contexto pequeno, não de poucas caras. */
  model: "sonnet",
  /** Modelo do subagente de Orientação. Campo plano, não aninhado, para que
   *  um config.json existente continue válido sem migração (ADR-0004). Haiku
   *  é o padrão porque a Orientação só precisa ler e relatar, nunca implementar
   *  — se a janela de 200K degradar num repo grande, troca-se para "sonnet".
   *  Não há knob de effort aqui: Haiku não aceita effort, e Sonnet custa 2x por
   *  token — como a Orientação é dominada por input, effort cortaria só a parte
   *  pequena da conta e nunca pagaria a troca de modelo. */
  orientationModel: "haiku",
  /** Teto de iterações do `ralph afk` quando -n não é passado. */
  maxIterations: 20,
  /** String que o agente emite dentro de <promise>…</promise> para encerrar. */
  completionPromise: "COMPLETE",
  /** String que o agente emite dentro de <promise>…</promise> quando está bloqueado. */
  blockedPromise: "BLOCKED",
  /** Prompt do loop, relativo à raiz do repo. */
  promptFile: ".ralph/prompt.md",
  /** Diário do loop, relativo à raiz do repo. */
  progressFile: ".ralph/PROGRESS.md",
  setupScript: ".ralph/setup.sh",
  /** Nome do sandbox. `null` = derivado do caminho do repo. */
  sandboxName: null,
  /** Workspaces extras montados no sandbox: "C:\\caminho" ou "C:\\caminho:ro". */
  extraMounts: [],
  /** Branches em que o Ralph pode rodar sem --allow-branch. */
  protectedBranches: ["main", "master"],
  /** Override do env de embeddings do servidor MCP efêmero do code-review-graph
   *  (`CRG_OPENAI_API_KEY`/`_BASE_URL`/`_MODEL`/`_DIMENSION`, ver
   *  knowledge-index.mjs) — vence, chave a chave, o que o Ralph já lê do
   *  `.mcp.json` do alvo (issue #20). Só precisa disto quem quer um valor
   *  diferente do declarado lá, ou não tem `.mcp.json` nenhum; endereço de
   *  loopback em `CRG_OPENAI_BASE_URL` é traduzido pro host do Docker
   *  automaticamente. */
  crgEmbeddingEnv: {},
  /** Segundos de espera entre iterações do AFK. */
  cooldownSeconds: 0,
  /** Provedor local (Ollama) para `--night` (issue #29/#40) — padrão validado
   *  nas três provas contra a máquina de referência do épico, não um chute.
   *  Único campo aninhado com padrão não-vazio: `loadConfig` o mescla um
   *  nível fundo, então declarar só um campo aqui não perde os outros. */
  nightProvider: {
    // de dentro do sandbox; loopback (127.0.0.1/localhost) é traduzido pro
    // host do Docker automaticamente, então o operador escreve o endereço
    // como se estivesse fora do container.
    baseUrl: `http://${dockerHostAddress()}:11434`,
    // tag da iteração — a única que passou nas três provas na máquina de
    // referência (issue #29, "O que foi medido, e onde").
    model: "qwen3-coder:30b-a3b-q4_K_M",
    // null = a Orientação herda o modelo acima (ADR-0007); declare uma tag
    // menor aqui só para a fase que lê e relata.
    orientationModel: null,
    // por quanto tempo o Ollama mantém o modelo residente entre iterações;
    // "8h" cobre uma noite inteira e expira sozinho, sem nada persistente
    // escrito no host (issue #34).
    keepAlive: "8h",
    // tamanho do prompt que o canário de contexto do doctor precisa provar
    // sem truncar — o modo de falha mais perigoso do Ollama é cortar o
    // prompt em silêncio e responder com confiança sobre o pedaço que
    // sobrou; baixar este valor é aceitar explicitamente menos contexto.
    minContext: 131072,
    // teto de cada prova de `/v1/messages` do doctor, e do aquecimento antes
    // da iteração 1 (issue #60). Generoso de propósito
    // (issue #57): night mode é gastar tempo de máquina ociosa em vez de
    // token pago, e um teto apertado reprovaria um Provedor íntegro pela
    // única dimensão que o conceito declara não medir — velocidade. Quem tem
    // máquina lenta e paciência declara sua paciência aqui.
    probeTimeoutSeconds: 900,
  },
};

export function ralphDir(root) {
  return path.join(root, ".ralph");
}

export function configPath(root) {
  return path.join(ralphDir(root), "config.json");
}

export function loadConfig(root) {
  const file = configPath(root);
  let user = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`.ralph/config.json inválido: ${err.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...user };
  // `nightProvider` é o primeiro campo aninhado com padrão não-vazio — merge
  // raso perderia baseUrl/keepAlive/minContext quando o operador só declara
  // `model`. Caso especial enquanto for o único (issue #40); generalizar
  // antes de existir um segundo campo assim é preparo para ninguém.
  cfg.nightProvider = { ...DEFAULTS.nightProvider, ...user.nightProvider };
  assertNightNumber("probeTimeoutSeconds", cfg.nightProvider.probeTimeoutSeconds, {
    max: MAX_PROBE_TIMEOUT_SECONDS,
    unit: "segundos",
  });
  assertNightNumber("minContext", cfg.nightProvider.minContext, {
    max: MAX_MIN_CONTEXT,
    unit: "tokens",
    integer: true,
  });
  cfg.sandboxName ||= sandboxNameFor(root);
  return cfg;
}

// `AbortSignal.timeout` só aceita milissegundos num inteiro sem sinal de 32
// bits — acima disso ele lança de dentro da sonda, e as três provas engolem
// exceção por projeto: o operador veria "troque nightProvider.model" por um
// número torto no teto. O vizinho de bloco é `keepAlive: "8h"`, então escrever
// `"15m"` aqui é o erro provável, não o exótico.
const MAX_PROBE_TIMEOUT_SECONDS = 4_294_967;

// O canário monta um prompt de alguns caracteres por token declarado — a razão
// medida contra o próprio Provedor desde a issue #55, limitada por
// `CANARY_RATIO_MAX` em provider.mjs —, então um `minContext` absurdo estoura o
// limite de string do V8 dentro da sonda — a mesma exceção engolida, o mesmo
// misdiagnóstico sobre o modelo. Dez milhões de tokens é ordens de grandeza
// acima do que qualquer modelo local aceita e ainda monta sem estourar.
const MAX_MIN_CONTEXT = 10_000_000;

/**
 * Guarda de campo numérico do `nightProvider` (issues #57 e #60). Ela existe
 * porque errar aqui não produz erro de config: produz exceção lá dentro da
 * sonda, onde as três provas engolem tudo por projeto e o veredito sai como
 * prescrição sobre o modelo. Daí a mensagem dizer o valor que veio, o que o
 * campo aceita e a edição que conserta.
 */
function assertNightNumber(field, value, { max, unit, integer = false }) {
  const wellFormed = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (wellFormed && value > 0 && value <= max) return;
  throw new Error(
    `.ralph/config.json: nightProvider.${field} é ${JSON.stringify(value)}, e precisa ser ` +
      `um número de ${unit} entre 0 e ${max}. Escreva o número puro, sem unidade ` +
      `(o padrão é ${DEFAULTS.nightProvider[field]}), ou apague o campo para herdá-lo.`,
  );
}

export function saveConfig(root, cfg) {
  mkdirSync(ralphDir(root), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function isInitialized(root) {
  return existsSync(configPath(root));
}

/**
 * `--night` e `--model` entram pela mesma costura (ADR-0006) — a mesma linha
 * de comando produz sempre o mesmo Provedor, nunca o relógio. Com `--night`,
 * `--model` sobrescreve `nightProvider.model` em vez de `cfg.model`: é
 * `provider.resolve` (src/provider.mjs) quem lê esse campo quando a flag está
 * ligada, e sem isso a tag do operador cairia num campo que o Provedor local
 * ignora.
 */
export function withOverrides(cfg, flags) {
  if (flags.night) cfg.night = true;
  if (flags.model) {
    if (cfg.night) cfg.nightProvider = { ...(cfg.nightProvider ?? {}), model: flags.model };
    else cfg.model = flags.model;
  }
  if (flags.prompt) cfg.promptFile = flags.prompt;
  return cfg;
}
