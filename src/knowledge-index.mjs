import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Um backend por assinatura de artefato em disco — mesmo padrão que
 * `detectFeedbackLoops` em cli.mjs já usa para achar scripts do package.json.
 *
 * Nenhum backend declara aqui como sobe seu MCP: o comando real precisa de
 * endereço de host e `--strict-mcp-config` traduzidos pro container (ADR-0002),
 * e essa tradução é trabalho de outra fatia. `detect` só prova presença.
 */
const BACKENDS = [
  {
    id: "code-review-graph",
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
    id: "graphify",
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
 * A costura: pura, sem Docker, rede ou disco. Recebe detecção e sonda como
 * dado — assinatura fixada aqui porque é a que as fatias seguintes (MCP
 * efêmero, lista de tools sondada) vão estender, sem trocar a forma.
 *
 * Hoje nenhum item de `detected` traz `mcpServer` (ver comentário em
 * `BACKENDS`), então `mcpConfig` sai `null` mesmo com backend achado — monta
 * a partir do campo quando ele existir, não assume comando nenhum.
 */
export function render(detected, probe) {
  if (!detected.length) return { promptBlock: "", mcpConfig: null, tools: [] };

  const promptBlock =
    "Este repositório tem índice de conhecimento montado. Consulte antes de varrer arquivo:\n" +
    detected.map((b) => `- ${b.label}: ${b.path}`).join("\n") +
    "\n";

  const mcpServers = {};
  for (const b of detected) {
    if (b.mcpServer) mcpServers[b.id] = b.mcpServer;
  }
  const mcpConfig = Object.keys(mcpServers).length ? { mcpServers } : null;

  return { promptBlock, mcpConfig, tools: [] };
}

function relativeAge(date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "hoje";
  if (days === 1) return "há 1 dia";
  return `há ${days} dias`;
}

/** Versão em prosa para o `doctor`. */
export function describe(detected) {
  return detected.map((b) => `índice ${b.label} detectado em ${b.path} (atualizado ${relativeAge(b.updatedAt)})`);
}
