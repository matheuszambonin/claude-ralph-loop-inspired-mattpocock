#!/usr/bin/env bash
# Roda DENTRO do sandbox, no diretório do repo, sempre que este arquivo muda.
#
# O sandbox nasce com o Claude Code e mais nada: sem as dependências do seu
# projeto, os feedback loops falham e o agente não consegue provar que o que
# escreveu funciona. Instale aqui o que `feedbackLoops` precisa para rodar.
#
# Precisa ser idempotente — roda de novo a cada edição deste script.
set -euo pipefail

# Python
# python3 -m pip install --quiet --break-system-packages -e ".[dev]"

# Node
# corepack enable && pnpm install --frozen-lockfile

# Rust
# rustup toolchain install stable

echo "setup: nada a fazer (edite .ralph/setup.sh)"
