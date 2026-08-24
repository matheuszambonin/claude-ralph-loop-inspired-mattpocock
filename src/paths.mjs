import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

/**
 * Docker Sandbox monta cada workspace do host "no mesmo caminho de dentro do
 * sandbox". No Windows isso significa `C:\Users\x\repo` -> `/c/Users/x/repo`.
 * Em Linux/macOS o caminho é preservado tal e qual.
 */
export function toContainerPath(hostPath) {
  const abs = path.resolve(hostPath);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!m) return abs.replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** Caminho do host no formato que o CLI do docker sandbox espera receber. */
export function toMountArg(hostPath, readOnly = false) {
  const abs = path.resolve(hostPath);
  return readOnly ? `${abs}:ro` : abs;
}

/** Raiz do repositório git a partir de `cwd`; cai no próprio cwd se não houver git. */
export function repoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return path.resolve(out);
  } catch {
    /* sem git: segue com o cwd */
  }
  return path.resolve(cwd);
}

/** Diretório `.claude` do usuário no host. */
export function userClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

/** Diretório de plugins do usuário, se existir. */
export function userPluginsDir() {
  const dir = path.join(userClaudeDir(), "plugins");
  return existsSync(dir) ? dir : null;
}

/** Raiz de instalação desta ferramenta. */
export function ralphHome() {
  return path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
}

/**
 * Nome de sandbox derivado do repo. O CLI só aceita letras, números, hífen,
 * underscore, ponto e sinais de mais/menos.
 */
export function sandboxNameFor(root) {
  const base = path.basename(root).replace(/[^A-Za-z0-9_.+-]/g, "-").toLowerCase();
  let hash = 0;
  for (const ch of path.resolve(root).toLowerCase()) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `ralph-${base}-${hash.toString(36)}`.slice(0, 60);
}
