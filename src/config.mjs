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
  cfg.sandboxName ||= sandboxNameFor(root);
  return cfg;
}

export function saveConfig(root, cfg) {
  mkdirSync(ralphDir(root), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function isInitialized(root) {
  return existsSync(configPath(root));
}
