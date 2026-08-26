#!/usr/bin/env bash
# Roda DENTRO do sandbox, uma vez por sandbox.
#
# O sandbox do Docker sobe um Claude Code pelado: nenhum plugin, nenhuma skill
# de usuário, nenhuma identidade de git. Este script reconstrói lá dentro o que
# o loop precisa — em especial o plugin mattpocock-skills, sem o qual
# /mattpocock-skills:implement não existe.
#
# Variáveis esperadas:
#   RALPH_PLUGINS_SRC  caminho (no container) do ~/.claude/plugins do host, :ro
#   RALPH_GIT_NAME     git user.name a configurar
#   RALPH_GIT_EMAIL    git user.email a configurar
#   RALPH_GIT_AUTOCRLF core.autocrlf efetivo no host, espelhado aqui
#   RALPH_REPO_PATH    caminho (no container) do repositório alvo montado
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
PLUGINS_DST="$CLAUDE_DIR/plugins"
STAMP="$CLAUDE_DIR/.ralph-bootstrap"

mkdir -p "$CLAUDE_DIR"

echo "· sandbox: $(claude --version 2>/dev/null || echo 'claude ausente')"

# ---------------------------------------------------------------- plugins ----
if [ -n "${RALPH_PLUGINS_SRC:-}" ] && [ -d "$RALPH_PLUGINS_SRC" ]; then
  mkdir -p "$PLUGINS_DST"
  for sub in cache marketplaces; do
    if [ -d "$RALPH_PLUGINS_SRC/$sub" ]; then
      rm -rf "${PLUGINS_DST:?}/$sub"
      cp -r "$RALPH_PLUGINS_SRC/$sub" "$PLUGINS_DST/$sub"
    fi
  done
  for f in known_marketplaces.json; do
    [ -f "$RALPH_PLUGINS_SRC/$f" ] && cp "$RALPH_PLUGINS_SRC/$f" "$PLUGINS_DST/$f"
  done
  chmod -R u+w "$PLUGINS_DST"

  # installPath vem com caminho do Windows; reaponta para dentro do container e
  # liga todo plugin instalado no settings.json (o sandbox nasce com o dele).
  RALPH_PLUGINS_SRC="$RALPH_PLUGINS_SRC" node - <<'NODE'
const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const src = process.env.RALPH_PLUGINS_SRC;
const dstDir = path.join(home, ".claude", "plugins");
const enabled = {};

const srcManifest = path.join(src, "installed_plugins.json");
if (fs.existsSync(srcManifest)) {
  const manifest = JSON.parse(fs.readFileSync(srcManifest, "utf8"));
  for (const [key, entries] of Object.entries(manifest.plugins ?? {})) {
    enabled[key] = true;
    for (const entry of entries) {
      const norm = String(entry.installPath ?? "").replace(/\\/g, "/");
      const idx = norm.toLowerCase().lastIndexOf("/plugins/cache/");
      entry.installPath =
        idx === -1 ? entry.installPath : path.join(dstDir, "cache", norm.slice(idx + "/plugins/cache/".length));
      entry.scope = "user";
    }
  }
  fs.writeFileSync(path.join(dstDir, "installed_plugins.json"), JSON.stringify(manifest, null, 2));
}

// known_marketplaces.json guarda installLocation com caminho do Windows. Sem
// reapontar, o Claude nao resolve o marketplace e ignora o plugin inteiro —
// installed_plugins.json correto nao basta.
const srcMarkets = path.join(src, "known_marketplaces.json");
if (fs.existsSync(srcMarkets)) {
  const markets = JSON.parse(fs.readFileSync(srcMarkets, "utf8"));
  for (const entry of Object.values(markets)) {
    const norm = String(entry.installLocation ?? "").replace(/\\/g, "/");
    const idx = norm.toLowerCase().lastIndexOf("/plugins/marketplaces/");
    if (idx !== -1) {
      entry.installLocation = path.join(dstDir, "marketplaces", norm.slice(idx + "/plugins/marketplaces/".length));
    }
  }
  fs.writeFileSync(path.join(dstDir, "known_marketplaces.json"), JSON.stringify(markets, null, 2));
}

const settingsPath = path.join(home, ".claude", "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {}
settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), ...enabled };
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log("· plugins habilitados: " + (Object.keys(enabled).join(", ") || "nenhum"));
NODE
else
  echo "· plugins: nenhuma origem montada (as skills do host não estarão disponíveis)"
fi

# -------------------------------------------------------------------- git ----
git config --global --get user.name  >/dev/null 2>&1 || git config --global user.name  "${RALPH_GIT_NAME:-Ralph}"
git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "${RALPH_GIT_EMAIL:-ralph@localhost}"
git config --global --add safe.directory '*'
if [ -n "${RALPH_GIT_AUTOCRLF:-}" ]; then
  git config --global core.autocrlf "$RALPH_GIT_AUTOCRLF"
  echo "· core.autocrlf=$RALPH_GIT_AUTOCRLF (espelhado do host)"
fi

# ------------------------------------------------------ hooks do alvo ----
# O post-commit do repositório alvo mora dentro do workspace montado. Sem
# neutralizar, ele roda aqui dentro quando o agente commita e regravaria o
# índice de conhecimento do host com caminho de container — corrompendo o
# banco que a sessão do host usa (ADR-0005). Global, não `--local`: o valor
# vence o `.git/hooks` do alvo sem apagar nada e sem tocar no `.git/config`
# dele, que é bind mount rw e levaria a neutralização de volta pro host,
# desligando os hooks do usuário fora do sandbox (fronteira do ADR-0001).
if [ -n "${RALPH_REPO_PATH:-}" ] && [ -d "$RALPH_REPO_PATH/.git" ]; then
  EMPTY_HOOKS="$CLAUDE_DIR/.ralph-empty-hooks"
  mkdir -p "$EMPTY_HOOKS"
  git config --global core.hooksPath "$EMPTY_HOOKS"
  echo "· hooks do repositório alvo neutralizados (core.hooksPath=$EMPTY_HOOKS)"
fi

# ------------------------------------------------------------------ stamp ----
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP"
echo "· bootstrap concluído"
