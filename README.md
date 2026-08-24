# Ralph

Loop Ralph Wiggum para Claude Code: **um contexto novo por iteração**, um
ticket por vez, dentro de um sandbox Docker, dirigido pelas skills do
[mattpocock/skills](https://github.com/mattpocock/skills).

> Ralph funciona porque é brutalmente simples: cada iteração começa com o
> contexto vazio, faz uma coisa, escreve o que aprendeu no disco e morre. É
> justamente isso que o plugin oficial `ralph-loop` quebra ao reciclar a mesma
> sessão via Stop hook — na terceira iteração o agente já está trabalhando na
> metade degradada da janela de contexto.

Aqui cada iteração é um processo `claude -p` novo. Nada atravessa iterações a
não ser o que está em disco: o repositório, os tickets e o `PROGRESS.md`.

## Requisitos

| Requisito | Por quê |
|---|---|
| Docker Desktop com `docker sandbox` | isolamento de cada iteração |
| Node.js 18+ | o CLI e o parser de stream (no lugar do `jq`) |
| Plugin `mattpocock-skills` instalado no host | é copiado para dentro do sandbox |
| `docs/agents/issue-tracker.md` no repo alvo | diz ao Ralph de onde puxar tarefas |

## Instalação

```bash
git clone https://github.com/matheuszambonin/claude-ralph-loop-inspired-mattpocock.git ralph
```

Não tem build nem dependência: é Node puro. Adicione `bin/` ao `PATH`, trocando
`C:\caminho\para\ralph` pelo lugar onde você clonou:

```powershell
$env:PATH += ";C:\caminho\para\ralph\bin"
# permanente:
[Environment]::SetEnvironmentVariable("PATH", "$([Environment]::GetEnvironmentVariable('PATH','User'));C:\caminho\para\ralph\bin", "User")
```

No Git Bash / WSL, `export PATH="$PATH:/caminho/para/ralph/bin"`.

## Primeiro uso num repo

```bash
cd meu-repo

# 1. o repo precisa saber onde ficam os tickets — dentro do Claude Code:
#    /mattpocock-skills:setup-matt-pocock-skills
#    /mattpocock-skills:to-spec          (conversa -> spec)
#    /mattpocock-skills:to-tickets       (spec -> fatias verticais)

ralph init         # cria .ralph/ e detecta os feedback loops do repo
#                    depois: preencha .ralph/setup.sh e feedbackLoops
ralph doctor       # confere docker, sandbox, plugins, login, tarefas
ralph login        # /login uma vez dentro do sandbox
ralph gh-login     # se o tracker do repo for GitHub Issues

git switch -c ralph/checkout
ralph once         # UMA iteração, você assistindo
ralph afk -n 20    # solta o loop
```

## Os dois modos

**HITL (`ralph once`)** — uma iteração, você olhando. É onde se aprende o que o
prompt precisa dizer. Rode isso até o agente acertar o alvo sem ajuda.

**AFK (`ralph afk -n N`)** — o loop de verdade. Pare em 5–10 iterações para
backlog pequeno, 30–50 para grande. Termina quando o agente emite
`<promise>COMPLETE</promise>` (backlog vazio), `<promise>BLOCKED</promise>`
(precisa de um humano) ou quando o teto de iterações é atingido.

Comece sempre HITL, refine o prompt, só então vá AFK.

## Como uma iteração funciona

```
ralph afk -n 20
   │
   ├─ garante o sandbox do repo (docker sandbox create)
   ├─ bootstrap: copia ~/.claude/plugins para dentro, configura git
   ├─ recusa rodar em main/master sem --allow-branch
   │
   └─ para cada iteração, um processo claude -p novo:
         claude --print --output-format stream-json --model sonnet
           │
           ├─ lê docs/agents/issue-tracker.md  → onde estão os tickets
           ├─ lê .ralph/PROGRESS.md            → o que já foi feito
           ├─ pega UM ticket ready-for-agent da frontier
           ├─ implementa via /mattpocock-skills:implement (+ /tdd)
           ├─ roda os feedback loops — não commita com nada vermelho
           ├─ /mattpocock-skills:code-review no próprio diff
           ├─ escreve a entrada no PROGRESS.md e fecha o ticket
           └─ commita
         ↓ o processo morre; o contexto vai junto
```

## O sandbox

O `docker sandbox` sobe um Claude Code pelado — sem os seus plugins, sem o seu
`CLAUDE.md` global. O `bootstrap.sh` conserta a parte que importa: monta
`~/.claude/plugins` read-only, copia para dentro do container, reescreve os
caminhos Windows (`C:\...` → `/c/...`) e liga os plugins no `settings.json` do
sandbox. Sem isso, `/mattpocock-skills:implement` simplesmente não existiria lá
dentro.

O que é montado (`ralph mounts` mostra):

| Host | Container | Modo |
|---|---|---|
| o repo | mesmo caminho, com `/c/` | leitura e escrita |
| `~/.claude/plugins` | idem | somente leitura |
| esta ferramenta | idem | somente leitura |

O seu home, suas chaves SSH e o resto do sistema ficam de fora.

### Autenticação

O sandbox é uma máquina separada: o token do host **não** é herdado. O Claude
de dentro precisa de login próprio, uma vez por sandbox — a credencial fica em
`~/.claude/.credentials.json` dentro do container e sobrevive a `exec`/`run`
até você dar `docker sandbox rm`.

```bash
ralph login                      # abre o Claude no sandbox; rode /login e /exit
ralph login --share-credentials  # alternativa: copia o token do host
```

**O primeiro `ralph login` num repo demora.** Ele cria o sandbox, e o
`docker sandbox create` baixa a imagem do template na primeira vez — alguns
minutos, com o progresso do docker aparecendo no terminal. Do segundo em
diante é instantâneo.

`ralph login` é literalmente `docker sandbox run <sandbox-do-repo>` — a mesma
coisa que `docker sandbox run claude`, com uma diferença que importa: `docker
sandbox run claude` cria um sandbox ad-hoc chamado `claude-<pasta>` montando só
o diretório atual, sem os plugins. Logar nele não autentica o sandbox do Ralph,
porque credencial é por sandbox.

`--share-credentials` deixa o agente capaz de ler seu token de sessão. Use só
em sandbox de confiança; o `/login` interativo é a opção conservadora.

### Dependências do projeto: `.ralph/setup.sh`

O sandbox nasce com o Claude Code e mais nada — sem pytest, sem node_modules,
sem toolchain. Se os `feedbackLoops` não conseguem rodar lá dentro, o agente
não tem como provar que o que escreveu funciona.

O `ralph init` cria um `.ralph/setup.sh` comentado. Preencha com o que o repo
precisa:

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m pip install --quiet --break-system-packages "pytest>=7.0" "numpy>=1.20"
```

Ele roda dentro do sandbox, no diretório do repo, e o carimbo carrega o hash do
arquivo: **editar o script já dispara uma nova execução**, sem precisar de
`--force`. Escreva-o idempotente.

### GitHub Issues como tracker

Se `docs/agents/issue-tracker.md` manda o agente usar `gh`, o sandbox precisa
do próprio login do `gh` — ele nasce sem token, sem `~/.config/gh` e sem
`GH_TOKEN`. Sem isso a primeira iteração bloqueia sem nem chegar a olhar um
ticket.

```bash
ralph gh-login           # device flow interativo dentro do sandbox
ralph gh-login --token   # injeta o token do 'gh auth token' do host
```

`--token` sem valor reaproveita o token do host, que costuma ter escopo
`repo` sobre **todos** os seus repositórios. O agente age no GitHub com o que
esse token permitir. Para um loop AFK, prefira um PAT fine-grained limitado ao
repositório alvo (Issues: read/write, Contents: read) e passe
`--token=<valor>`.

## Configuração

`.ralph/config.json`, criado pelo `ralph init`:

```jsonc
{
  "model": "sonnet",              // muitas iterações baratas > poucas caras
  "maxIterations": 20,            // teto padrão do afk
  "completionPromise": "COMPLETE",
  "blockedPromise": "BLOCKED",
  "promptFile": ".ralph/prompt.md",
  "progressFile": ".ralph/PROGRESS.md",
  "sandboxName": "ralph-meu-repo-1feo4ed",
  "extraMounts": [],              // "C:\\caminho" ou "C:\\caminho:ro"
  "protectedBranches": ["main", "master"],
  "cooldownSeconds": 0,
  "feedbackLoops": [              // detectado do package.json no init
    "npm run typecheck",
    "npm run test",
    "npm run lint"
  ]
}
```

`feedbackLoops` é a parte que mais decide a qualidade do resultado. São os
comandos que o agente é proibido de contornar antes de commitar — sem eles,
Ralph commita às cegas. Se o repo não é Node, preencha à mão (`cargo test`,
`pytest -q`, `mise run check`, o que for).

## Prompts de loop

`ralph init --prompt <nome>` copia um dos templates de `prompts/` para
`.ralph/prompt.md`, onde você pode editá-lo à vontade:

- **`implement`** (padrão) — consome o backlog de tickets via
  `/mattpocock-skills:implement`
- **`entropy`** — remove duplicação, código morto e padrões inconsistentes, um
  por iteração
- **`test-coverage`** — cobre uma lacuna de teste por iteração, priorizada por
  risco

Os placeholders `{{PROGRESS_FILE}}`, `{{COMPLETION_PROMISE}}`,
`{{BLOCKED_PROMISE}}` e `{{FEEDBACK_LOOPS}}` são substituídos a cada iteração a
partir do config.

## Comandos

| Comando | O que faz |
|---|---|
| `ralph init [--prompt <nome>] [--force]` | cria `.ralph/` no repo atual |
| `ralph doctor` | checa docker, sandbox, plugins, login e fonte de tarefas |
| `ralph login [--share-credentials]` | autentica o Claude dentro do sandbox |
| `ralph gh-login [--token[=valor]]` | autentica o `gh` dentro do sandbox |
| `ralph once [--allow-branch]` | uma iteração (HITL) |
| `ralph afk [-n N] [--allow-branch]` | o loop (AFK) |
| `ralph status` | últimas entradas do `PROGRESS.md` |
| `ralph shell` | bash dentro do sandbox |
| `ralph bootstrap [--force]` | reinstala plugins/skills no sandbox |
| `ralph sandboxes` / `ralph mounts` / `ralph rm` | inspeção e limpeza |

Opções comuns: `--model <nome>`, `--prompt <arquivo>`, e `-- <args>` para
repassar argumentos crus ao `claude`.

## Streaming

`claude --print` não emite nada até terminar. O Ralph usa
`--output-format stream-json --verbose` e renderiza cada evento na hora — o
papel que o filtro `jq` cumpre nos artigos do aihero.dev, aqui feito em Node
(`src/stream.mjs`), porque a máquina não tem `jq` e o parser em JS aguenta
linha partida no meio do chunk.

Cada iteração também grava o stream cru em `.ralph/logs/<timestamp>-iter-NN.jsonl`
(ignorado pelo git) para quando algo der errado às 3h da manhã.

## Operação — o que os artigos ensinam

- **Tickets pequenos.** A taxa de feedback é o seu limite de velocidade. Fatia
  vertical fina, demonstrável sozinha, que caiba numa janela de contexto.
- **Risco primeiro.** Arquitetura, pontos de integração e incógnitas vão para o
  começo — e de preferência em HITL. Polimento de UI fica para o AFK.
- **Diga qual é o nível de qualidade.** Protótipo, produção ou biblioteca são
  padrões de código diferentes; o agente não adivinha em que repo está. Escreva
  isso no `CLAUDE.md` do repo.
- **Enxugue o `PROGRESS.md`.** Ele é lido inteiro por toda iteração futura. Um
  diário inchado envenena todos os contextos seguintes.
- **Leia os commits, não só o resultado.** Um commit por iteração existe para
  você poder desfazer exatamente uma iteração.

## Créditos

Técnica original: Geoffrey Huntley. Prática, prompts e os três artigos que este
projeto segue: [Matt Pocock, aihero.dev](https://www.aihero.dev) —
[por que o plugin oficial falha](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks),
[11 dicas](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum),
[streaming AFK](https://www.aihero.dev/heres-how-to-stream-claude-code-with-afk-ralph).

O código aqui é original: os artigos são a fonte da técnica, não do código.
MIT — veja [LICENSE](LICENSE).
