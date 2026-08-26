import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./sandbox.mjs";
import { dockerHostAddress, translateLoopback } from "./paths.mjs";

// Carimbo por sandbox, mesmo padrão do `.ralph-bootstrap` em runner.mjs: um
// arquivo dentro do próprio sandbox, checado antes de repetir o trabalho.
// Aqui o conteúdo importa (não só a existência), porque o que se carimba é o
// resultado da sonda, não so o fato de ter rodado.
const OLLAMA_PROBE_STAMP = "/home/agent/.claude/.ralph-ollama-probe";
const OLLAMA_PORT = 11434;

/**
 * Filtro de dez tools do `code-review-graph` (que expõe trinta) que a
 * iteração recebe — as que a fase de orientação usa de fato. Só
 * `semantic_search_nodes_tool` precisa embeddar a query; as outras nove são
 * consulta pura sobre o SQLite do grafo (ADR-0003).
 */
const CRG_TOOLS = [
  "get_minimal_context_tool",
  "get_impact_radius_tool",
  "get_review_context_tool",
  "query_graph_tool",
  "traverse_graph_tool",
  "semantic_search_nodes_tool",
  "list_graph_stats_tool",
  "find_large_functions_tool",
  "detect_changes_tool",
  "get_architecture_overview_tool",
];
const CRG_EMBEDDING_TOOL = "semantic_search_nodes_tool";
export const CRG_ID = "code-review-graph";
const GRAPHIFY_ID = "graphify";

/**
 * Dica curta por backend para o bloco de orientação (issue #4) — chaveada por
 * `id`, não carregada no item detectado, porque é constante do backend, não
 * dado observado. `code-review-graph` devolve caminho absoluto do host nas
 * suas respostas (indexado por uma sessão de host, ver ADR-0002); sem a
 * regra, o primeiro caminho que a tool devolver é um `file not found` dentro
 * do sandbox. `graphify` é consultado em prosa — lendo o manifesto
 * diretamente, sem tool — e reler o documento inteiro a cada consulta custa
 * o que o índice deveria evitar.
 *
 * Texto em inglês, não português: este bloco vai colado dentro de
 * `prompts/*.md`, e a convenção do repo reserva esses arquivos para inglês.
 */
const PROMPT_HINTS = {
  [CRG_ID]:
    "paths this tool returns are host-formatted (`C:\\...`); translate to the sandbox by lowercasing the drive letter and turning backslashes into slashes (`/c/...`)",
  [GRAPHIFY_ID]: "read the manifest's navigation section, not the whole document",
};

/**
 * Custo relativo por backend (issue #18) — menor primeiro. Julgamento de
 * produto, não fato medido: valide antes de aceitar, não só codifique.
 *
 * `code-review-graph` tem `get_minimal_context_tool` — CRG_TOOLS já existe
 * porque o backend responde a uma pergunta pontual sem ler mais que isso.
 * `graphify` não tem tool nenhuma: mesmo "só a seção de navegação"
 * (PROMPT_HINTS acima) é um recorte de arquivo, não uma consulta — não há
 * como pedir menos que isso ao manifesto. A diferença que sustenta a ordem
 * não é "SQLite é rápido", é ter ou não um caminho para pedir só o que
 * precisa. Só entra no bloco de prompt quando dois ou mais backends
 * coexistem, porque com um só não há ordem para escolher.
 */
const BACKEND_COST_RANK = {
  [CRG_ID]: 0,
  [GRAPHIFY_ID]: 1,
};
const BACKEND_COST_WHY = {
  [CRG_ID]: "a single structured query",
  [GRAPHIFY_ID]: "always reads a document",
};

/**
 * Um backend por assinatura de artefato em disco — mesmo padrão que
 * `detectFeedbackLoops` em cli.mjs já usa para achar scripts do package.json.
 *
 * Nenhum backend declara aqui como sobe seu MCP: o comando real precisa do
 * caminho de container, que só existe na hora da iteração (issue #7),
 * então `detect` só prova presença — quem monta o comando é `render`.
 */
const BACKENDS = [
  {
    id: CRG_ID,
    label: "code-review-graph",
    // O próprio projeto documenta a convenção no .gitignore dele: banco
    // SQLite dentro de `.code-review-graph/`, extensão `.db`.
    locate(root) {
      const dir = path.join(root, ".code-review-graph");
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
      const db = readdirSync(dir).find((f) => f.endsWith(".db"));
      return db ? path.join(dir, db) : null;
    },
  },
  {
    id: GRAPHIFY_ID,
    label: "graphify",
    // `graphify-out/graph.json` é o manifesto que a ferramenta escreve ao
    // terminar uma rodada — a assinatura mais estável que ela expõe.
    locate(root) {
      const file = path.join(root, "graphify-out", "graph.json");
      return existsSync(file) ? file : null;
    },
  },
];

function toDetected(backend, artifactPath) {
  return {
    id: backend.id,
    label: backend.label,
    path: artifactPath,
    updatedAt: statSync(artifactPath).mtime,
  };
}

/**
 * Assinatura no disco do repositório alvo. `cfg.knowledgeIndex`: ausente ou
 * `null` autodetecta; `false` desliga; objeto declara explicitamente quais
 * backends usar (chave = id, valor `true` usa o caminho padrão do backend,
 * string sobrescreve o caminho).
 */
export function detect(root, cfg = {}) {
  const declared = cfg.knowledgeIndex;
  if (declared === false) return [];

  if (declared && typeof declared === "object") {
    const detected = [];
    for (const [id, value] of Object.entries(declared)) {
      const backend = BACKENDS.find((b) => b.id === id);
      if (!backend || !value) continue;
      const artifactPath = typeof value === "string" ? path.resolve(root, value) : backend.locate(root);
      if (artifactPath && existsSync(artifactPath)) detected.push(toDetected(backend, artifactPath));
    }
    return detected;
  }

  const detected = [];
  for (const backend of BACKENDS) {
    const artifactPath = backend.locate(root);
    if (artifactPath) detected.push(toDetected(backend, artifactPath));
  }
  return detected;
}

/**
 * Pergunta, de dentro do sandbox, se o Ollama do host responde na porta de
 * embeddings. Carimbado por sandbox (ver `OLLAMA_PROBE_STAMP`) para não
 * repetir a sonda a cada iteração — o sandbox precisa ser recriado para que a
 * sonda rode de novo, mesmo padrão de invalidação do `.ralph-bootstrap`.
 *
 * Teste de TCP puro (`/dev/tcp` do bash), não HTTP: o que importa aqui é se a
 * porta abre, que é exatamente o que falha no caso medido (Ollama escutando
 * só em loopback) sem exigir `curl` dentro do sandbox.
 */
export async function probe(sandboxName) {
  const cached = await execCapture(sandboxName, ["cat", OLLAMA_PROBE_STAMP]);
  const value = cached.stdout.trim();
  if (cached.code === 0 && (value === "reachable" || value === "unreachable")) {
    return { ollamaReachable: value === "reachable" };
  }

  const host = dockerHostAddress();
  const check = await execCapture(sandboxName, [
    "bash",
    "-lc",
    `timeout 2 bash -c 'exec 3<>/dev/tcp/${host}/${OLLAMA_PORT}' 2>/dev/null`,
  ]);
  const ollamaReachable = check.code === 0;

  await execCapture(sandboxName, ["bash", "-lc", `echo ${ollamaReachable ? "reachable" : "unreachable"} > ${OLLAMA_PROBE_STAMP}`]);

  return { ollamaReachable };
}

/**
 * `.mcp.json` do alvo lido **como dado**, nunca como configuração de sessão
 * (ADR-0005, "executar não é ler" — `--strict-mcp-config`, sempre presente na
 * issue #7, já garante que a sessão não roda o que está aqui). Ausente,
 * inválido ou sem o servidor `code-review-graph`: `{}` — mesmo grau de
 * silêncio que o resto do módulo usa para degradação (ADR-0003), não uma
 * exceção por um arquivo que a sessão nem chega a executar.
 */
export function readTargetMcpConfig(root) {
  const file = path.join(root, ".mcp.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Env de embeddings do `code-review-graph`: o que o `.mcp.json` do alvo já
 * declara (issue #20 — medido no Terraços, quatro variáveis, não as três que
 * `crgEmbeddingEnv` documentava) mais o que o operador sobrescreveu em
 * `crgEmbeddingEnv`, que vence chave a chave — é o operador corrigindo o que
 * o `.mcp.json` errar ou não tiver. Pura: recebe os dois lados como dado.
 *
 * `CRG_TOOLS`, se presente no `.mcp.json` do alvo, é descartado sempre:
 * importá-lo em bloco desfaria por variável de ambiente o filtro que a sonda
 * de Ollama já aplicou (ADR-0003), devolvendo à sessão a tool que ela tinha
 * removido.
 */
export function resolveEmbeddingEnv(targetMcpConfig, override = {}) {
  const { CRG_TOOLS: _discarded, ...fromTarget } = targetMcpConfig?.mcpServers?.[CRG_ID]?.env ?? {};
  return { ...fromTarget, ...override };
}

/**
 * Comando MCP efêmero do `code-review-graph` (`serve`, documentado no README
 * upstream) — `--repo` recebe o caminho já traduzido pro container por quem
 * chama, nunca o do host (ADR-0002), e `--tools` a lista que a sonda de
 * Ollama já filtrou (ADR-0003). `graphify` não sobe MCP (é lido em prosa),
 * então devolve `null` para qualquer outro id.
 *
 * `embeddingEnv` é o único jeito de ligar a busca semântica de verdade: o
 * provedor de embeddings do `code-review-graph` (`CRG_OPENAI_API_KEY` +
 * `CRG_OPENAI_BASE_URL` + `CRG_OPENAI_MODEL`, verificado no código upstream)
 * são segredo e modelo que só o operador sabe — Ralph não inventa nenhum dos
 * dois, só traduz o endereço de loopback de `CRG_OPENAI_BASE_URL`, venha ele
 * do `.mcp.json` do alvo ou de `crgEmbeddingEnv` (`resolveEmbeddingEnv` já
 * resolveu os dois antes de chegar aqui).
 */
function mcpServerFor(id, containerRoot, tools, embeddingEnv) {
  if (id !== CRG_ID || !tools.length) return null;
  const server = { command: CRG_ID, args: ["serve", "--repo", containerRoot, "--tools", tools.join(",")] };
  const entries = Object.entries(embeddingEnv ?? {});
  if (entries.length) {
    server.env = Object.fromEntries(
      entries.map(([key, value]) => [key, key === "CRG_OPENAI_BASE_URL" ? translateLoopback(value) : value])
    );
  }
  return server;
}

/**
 * Linha extra do bloco de prompt (issue #18) quando dois ou mais backends
 * coexistem — nomeia o mais barato e por quê, para o agente não escolher por
 * ordem arbitrária de detecção.
 */
function costPriorityLine(detected) {
  const [cheapest] = [...detected].sort(
    (a, b) => (BACKEND_COST_RANK[a.id] ?? Infinity) - (BACKEND_COST_RANK[b.id] ?? Infinity)
  );
  const why = BACKEND_COST_WHY[cheapest.id];
  return `Start with ${cheapest.label} — it's the cheaper lookup${why ? ` (${why})` : ""}; only check the others if it doesn't answer.`;
}

/**
 * A costura: pura, sem Docker, rede ou disco. Recebe detecção e sonda como
 * dado.
 *
 * `opts.containerRoot` ausente (chamadas que só querem o bloco de prompt,
 * como a Orientação) devolve `mcpConfig: null` mesmo com backend achado — sem
 * o caminho de container não há `--repo` para montar, e um comando com
 * caminho de host quebraria dentro do sandbox (ADR-0002).
 *
 * `probeResult` ausente (repositório sem sandbox ainda sondado) degrada como
 * se o Ollama estivesse inalcançável — ADR-0003: uma tool ausente é melhor
 * que uma tool que mente, e assumir "alcançável" sem prova seria a mentira.
 */
export function render(detected, probeResult, opts = {}) {
  if (!detected.length) return { promptBlock: "", mcpConfig: null, tools: [] };

  const promptBlock =
    "Knowledge index detected — consult it before you grep:\n" +
    detected
      .map((b) => `- ${b.label} (${b.path})` + (PROMPT_HINTS[b.id] ? `: ${PROMPT_HINTS[b.id]}` : ""))
      .join("\n") +
    "\n" +
    (detected.length > 1 ? costPriorityLine(detected) + "\n" : "");

  const ollamaReachable = probeResult?.ollamaReachable ?? false;
  const tools = [];
  for (const b of detected) {
    if (b.id !== CRG_ID) continue;
    tools.push(...(ollamaReachable ? CRG_TOOLS : CRG_TOOLS.filter((t) => t !== CRG_EMBEDDING_TOOL)));
  }

  const mcpServers = {};
  if (opts.containerRoot) {
    for (const b of detected) {
      const server = mcpServerFor(b.id, opts.containerRoot, tools, opts.embeddingEnv);
      if (server) mcpServers[b.id] = server;
    }
  }
  const mcpConfig = Object.keys(mcpServers).length ? { mcpServers } : null;

  return { promptBlock, mcpConfig, tools };
}

const INSTALL_BLOCK_START = "# --- ralph:knowledge-index begin (gerado por `ralph init`, não edite à mão) ---";
const INSTALL_BLOCK_END = "# --- ralph:knowledge-index end ---";

/**
 * Trecho do `code-review-graph` em si — só ele precisa de binário dentro do
 * sandbox (issue #6: a tool MCP não sobe sem o comando existir lá). `graphify`
 * é lido em prosa direto do manifesto (ver `PROMPT_HINTS`) e não instala nada.
 *
 * O pacote exige Python >=3.10 (pypi.org/project/code-review-graph) e o
 * sandbox padrão do Docker não garante isso no `python3` default — por isso o
 * trecho varre os interpretadores versionados mais comuns e fixa o primeiro
 * que servir, em vez de confiar cegamente no `python3` do PATH (que, sem essa
 * varredura, dá um erro de `pip` reclamando de sintaxe alheia, não o motivo
 * real). Não foi possível provar contra um sandbox de verdade quais
 * interpreters ele realmente tem — comentado na issue #6 ao fechar.
 */
function crgInstallSnippet() {
  return [
    "# code-review-graph precisa do binário de consulta dentro do sandbox —",
    "# a tool MCP do índice não sobe sem ele (ADR-0002). Idempotente: rodar de",
    "# novo só reconfirma que o pacote está instalado.",
    'crg_python=""',
    "for candidate in python3.13 python3.12 python3.11 python3.10 python3; do",
    '  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c \'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)\' 2>/dev/null; then',
    '    crg_python="$candidate"',
    "    break",
    "  fi",
    "done",
    'if [ -z "$crg_python" ]; then',
    '  echo "setup: nenhum interpretador Python >=3.10 encontrado (exigido por code-review-graph)." >&2',
    '  echo "setup: instale um (ex.: python3.12) e adicione ao PATH do sandbox." >&2',
    "  exit 1",
    "fi",
    '"$crg_python" -m pip install --quiet --break-system-packages code-review-graph',
  ].join("\n");
}

/** Snippet de instalação, ou `null` quando nenhum backend detectado precisa de binário no sandbox. */
function installSnippet(detected) {
  return detected.some((b) => b.id === CRG_ID) ? crgInstallSnippet() : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Injeta (ou atualiza, ou remove) o passo de instalação do backend dentro de
 * `setup.sh` do repositório alvo — issue #6. Pura: recebe o script e a
 * detecção como dado, sem tocar disco, para ficar testável sem sandbox.
 *
 * O bloco é delimitado por marcadores para que reaplicar (`ralph init` de
 * novo, ou um backend novo aparecendo) substitua em vez de duplicar — mesma
 * garantia que ADR-0001 pede para o resto do índice: detectar de novo não
 * pode acumular lixo. Repositório sem backend que precise de binário (sem
 * índice, ou só `graphify`) devolve o script **idêntico**, byte a byte — a
 * mesma prova que a issue #4 já fez para o placeholder do prompt.
 */
export function withInstallBlock(setupScript, detected) {
  // Exige o `\n` de cada lado (não `\n?`) porque é exatamente o que a inserção
  // abaixo acrescenta ao redor do bloco — casar só esses dois devolve o script
  // ao estado anterior à inserção, sem sobrar nem faltar linha em branco.
  // Um `\n?` opcional nos dois lados comeria as quebras originais também,
  // acumulando uma linha em branco a mais a cada reaplicação.
  const blockRe = new RegExp(`\\n${escapeRegExp(INSTALL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(INSTALL_BLOCK_END)}\\n`);
  const withoutBlock = setupScript.replace(blockRe, "");

  const snippet = installSnippet(detected);
  if (!snippet) return withoutBlock;

  const block = `${INSTALL_BLOCK_START}\n${snippet}\n${INSTALL_BLOCK_END}`;
  const anchor = "set -euo pipefail\n";
  const idx = withoutBlock.indexOf(anchor);
  if (idx === -1) return `${withoutBlock.trimEnd()}\n\n${block}\n`;

  const insertAt = idx + anchor.length;
  return `${withoutBlock.slice(0, insertAt)}\n${block}\n${withoutBlock.slice(insertAt)}`;
}

function relativeAge(date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "hoje";
  if (days === 1) return "há 1 dia";
  return `há ${days} dias`;
}

/**
 * Versão em prosa para o `doctor`. A issue #1 esboçou `describe(detected,
 * probe)` como uma função só; ficou `describeDegradation` separada porque o
 * `doctor` pinta as duas coisas com cor diferente (`ok` verde aqui, `warn`
 * amarelo lá) — devolver os dois tipos de linha misturados obrigaria o
 * `doctor` a inspecionar texto pra saber qual cor usar.
 */
export function describe(detected) {
  return detected.map((b) => `índice ${b.label} detectado em ${b.path} (atualizado ${relativeAge(b.updatedAt)})`);
}

/** Se algum detectado é o `code-review-graph` — o único backend que sobe MCP e por isso o único que precisa de sonda (Ollama) ou de binário no sandbox. */
function hasCrgBackend(detected) {
  return detected.some((b) => b.id === CRG_ID);
}

/** Se algum detectado precisa da sonda de Ollama — hoje só o `code-review-graph`. */
export function needsOllamaProbe(detected) {
  return hasCrgBackend(detected);
}

/**
 * Aviso de iteração quando o índice foi achado em disco mas o servidor MCP
 * dele não subiu na sessão — o sintoma medido na issue #1: o `.mcp.json` do
 * repositório alvo aponta para um servidor que falha dentro do sandbox
 * (binário ausente, `localhost` resolvendo pro próprio container) e a
 * iteração varre arquivo sem que ninguém saiba por quê. Casa o nome do
 * servidor no evento `init` com o `id` do backend detectado — a mesma
 * convenção que `render` usa em `mcpServers[b.id]`.
 *
 * `mcpServers` que não é array (sessão sem o campo, ou repositório sem
 * índice) devolve `null` — silêncio, não suposição.
 *
 * Fecha com `ralph doctor` (CLAUDE.md: "erro de usuário diz o comando que
 * conserta") porque, desde a issue #12, o `doctor` checa se o binário do
 * backend está no PATH do sandbox — a causa mais comum deste aviso. Não prova
 * que o binário instalado de fato conecta (caminho de `--repo` errado, banco
 * corrompido); só descarta a causa mais barata de investigar primeiro.
 */
export function describeMcpFailure(detected, mcpServers) {
  if (!detected.length || !Array.isArray(mcpServers)) return null;
  const failed = detected.filter((b) =>
    mcpServers.some((s) => s.name === b.id && s.status !== "connected")
  );
  if (!failed.length) return null;
  return (
    `MCP do índice de conhecimento não subiu na sessão: ${failed.map((b) => b.label).join(", ")}. ` +
    "Esta iteração vai varrer arquivo em vez de consultar o índice. " +
    "Rode 'ralph doctor' para descobrir por quê."
  );
}

/**
 * Confirma, de dentro do sandbox, que o binário do backend está instalado e
 * no PATH — a causa mais provável de `describeMcpFailure` disparar depois que
 * o `setup.sh` já rodou uma vez: reinstalar o sandbox (`ralph rm`), um
 * `python3` diferente ganhando o PATH, ou o `.ralph/setup.sh` nunca tendo
 * rodado porque `ralph doctor` roda sem preparar o sandbox. Só `graphify` não
 * precisa de binário (é lido em prosa), então devolve `null` para ele.
 */
export async function probeInstall(sandboxName, detected) {
  if (!hasCrgBackend(detected)) return null;
  const check = await execCapture(sandboxName, ["bash", "-lc", `command -v ${CRG_ID} >/dev/null 2>&1 && echo yes || echo no`]);
  return { installed: check.stdout.trim() === "yes" };
}

/**
 * Linha de aviso amarela para o `doctor` quando o binário do backend não está
 * no PATH do sandbox. `installResult` ausente (repositório sem backend que
 * precise de binário) devolve `null` — mesma convenção de `describeDegradation`.
 */
export function describeInstallFailure(installResult) {
  if (!installResult || installResult.installed) return null;
  return (
    "binário do code-review-graph ausente no sandbox — o MCP do índice não vai subir e a iteração vai varrer arquivo. " +
    "Rode 'ralph bootstrap --force' para reinstalar."
  );
}

/**
 * Linha verde para o `doctor` quando a busca semântica está disponível — a
 * issue #13 pegou que a linha antiga nomeava o backend duas vezes
 * (`code-review-graph` no texto, "Ollama alcançável" no processo por trás
 * dele) onde o CONTEXT.md pede o conceito (índice de conhecimento), não o
 * backend. Fala do índice e do `label` do backend detectado; o nome do
 * processo (Ollama) fica só na linha de degradação, onde é acionável.
 */
export function describeAvailability(detected) {
  const backend = detected.find((b) => b.id === CRG_ID);
  if (!backend) return null;
  return `busca semântica do índice de conhecimento disponível (${backend.label})`;
}

/**
 * Linha de aviso amarela para o `doctor` quando a busca semântica degradou —
 * `null` quando não há `code-review-graph` detectado ou quando o Ollama
 * respondeu. Erro de usuário diz o comando que conserta (CLAUDE.md).
 */
export function describeDegradation(detected, probeResult) {
  if (!needsOllamaProbe(detected)) return null;
  if (probeResult?.ollamaReachable) return null;
  return (
    "busca semântica do code-review-graph indisponível: Ollama do host inalcançável a partir do sandbox " +
    `(${dockerHostAddress()}:${OLLAMA_PORT}). As outras nove tools do índice continuam funcionando. ` +
    "Para religar: rode o Ollama do host com OLLAMA_HOST=0.0.0.0 e reinicie o serviço."
  );
}
