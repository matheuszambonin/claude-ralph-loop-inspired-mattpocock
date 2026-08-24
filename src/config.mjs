import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sandboxNameFor } from "./paths.mjs";

export const DEFAULTS = {
  /** Modelo de cada iteração. Sonnet é o padrão: Ralph vive de muitas
   *  iterações baratas com contexto pequeno, não de poucas caras. */
  model: "sonnet",
  /** Teto de iterações do `ralph afk` quando -n não é passado. */
  maxIterations: 20,
  /** String que o agente emite dentro de <promise>…</promise> para encerrar. */
  completionPromise: "COMPLETE",
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
  /** Segundos de espera entre iterações do AFK. */
  cooldownSeconds: 0,
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
