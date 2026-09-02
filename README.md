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

O bloqueio vale mesmo quando o agente só o pensou: um modelo pequeno escreve
"I should emit `<promise>BLOCKED</promise>`" enquanto raciocina e entrega um
texto final sem a tag, e a noite inteira se vai reencontrando o mesmo backlog
vazio. `COMPLETE` continua exigindo a tag no texto: o prompt lista as duas, e
um "não é `<promise>COMPLETE</promise>`" pensado fecharia a noite como sucesso
sobre um backlog cheio.

O resumo de orientação decide sozinho, sem esperar a promise. Quando ele volta
com `STATUS: blocked` ou `STATUS: complete`, o Ralph corta a iteração ali,
antes de ela tocar no repositório alvo, e o desfecho é o mesmo da promise
correspondente. Em 01/09/2026 um modelo de 9B leu `STATUS: blocked` e leu
junto o `CONTEXT` que descrevia o que faltava num ticket; implementou, fechou
a issue e commitou assim mesmo. Pedir ao prompt que a iteração ignore o que
acabou de ler não segura isso. Ler o `STATUS` do lado de fora segura.

Comece sempre HITL, refine o prompt, só então vá AFK.

## Como uma iteração funciona

```
ralph afk -n 20
   │
   ├─ garante o sandbox do repo (docker sandbox create)
   ├─ bootstrap: copia ~/.claude/plugins para dentro, instala o gh oficial, configura git
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

Repo que vive fora de disco local — Google Drive File Stream, OneDrive, volume
de rede mapeado — não monta. O compartilhamento de arquivos do `docker sandbox`
é virtiofs, e ele falha antes do boot da VM. O `ralph doctor` avisa e o
`ralph login` explica; o que não existe é um modo sem sandbox para contornar
(ADR-0011). A saída é trabalhar num clone em disco local.

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

**A cópia não acompanha o host.** O token copiado vence em horas e o refresh
dele é rotacionado toda vez que o host renova o dele — quando isso acontece, a
sessão de dentro do sandbox morre com `OAuth session expired and could not be
refreshed`. O `ralph doctor` lê a expiração do arquivo e acusa antes de você
gastar uma iteração; o conserto é rodar `ralph login --share-credentials` de
novo.

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
  "orientationModel": "haiku",    // o subagente que faz a Orientação
  "maxIterations": 20,            // teto padrão do afk
  "completionPromise": "COMPLETE",
  "blockedPromise": "BLOCKED",
  "promptFile": ".ralph/prompt.md",
  "progressFile": ".ralph/PROGRESS.md",
  "sandboxName": "ralph-meu-repo-1feo4ed",
  "extraMounts": [],              // "C:\\caminho" ou "C:\\caminho:ro"
  "protectedBranches": ["main", "master"],
  "crgEmbeddingEnv": {},          // env de embeddings do índice de conhecimento
  "cooldownSeconds": 0,
  "iterationTimeoutSeconds": 3600, // teto de tempo de uma iteração
  "feedbackLoops": [              // detectado do package.json no init
    "npm run typecheck",
    "npm run test",
    "npm run lint"
  ]
}
```

`iterationTimeoutSeconds` é o teto de tempo de uma iteração. Estourado, o
processo do `claude` morre, o log `.jsonl` daquela iteração fica em disco até
onde chegou e o `afk` para — a mesma saída de qualquer iteração que falha, e
pelo mesmo motivo: a máquina acabou de dar sinal de travamento. Uma hora é
generoso de propósito, porque máquina lenta com modelo grande é espera longa
legítima; o que não é legítimo é `ralph afk --night` queimando a noite inteira
em laço fechado — e para esse o Ralph não espera o relógio: a iteração que
repete a mesma chamada morre em segundos, seja a Orientação repetindo, seja o
processo principal, e o loop segue para a próxima.

`feedbackLoops` é a parte que mais decide a qualidade do resultado. São os
comandos que o agente é proibido de contornar antes de commitar — sem eles,
Ralph commita às cegas. Se o repo não é Node, preencha à mão (`cargo test`,
`pytest -q`, `mise run check`, o que for).

`crgEmbeddingEnv` só existe para repositório que tem índice de conhecimento
(`code-review-graph`). São as variáveis de ambiente que o servidor do índice
precisa para embeddar, as mesmas com que ele já roda no host. Quais são elas
é pergunta para o `code-review-graph`, não para o Ralph. Quem responde é o
`.mcp.json` do repositório alvo, que muda junto com o projeto, e por isso o
Ralph lê o env declarado lá e usa como está. `crgEmbeddingEnv` sobrescreve
chave a chave, para quem não tem `.mcp.json` ou quer um valor diferente dentro
do sandbox. Endereço de loopback vira o host do Docker automaticamente, então
escreva como se estivesse fora do container.

Sem provedor de embeddings resolvido nas duas origens, `ralph doctor` avisa em
amarelo. A busca semântica fica de fora, e as outras tools do índice continuam
respondendo.

## Night mode

`--night` troca de onde vem a inferência de uma iteração: em vez da API paga
da Anthropic, o Claude Code de dentro do sandbox fala com um **Provedor**
local — o Ollama da máquina do operador. Existe para gastar tempo de máquina
ociosa em vez de token pago — **não** para sigilo (o código já sai da máquina
para o sandbox local do jeito de sempre) e **não** para velocidade (um modelo
local roda mais devagar que a API paga). `ralph afk -n 40 --night` custa o
consumo de energia de uma noite, não a fatura de 40 iterações do Claude pago.

O modo é tudo-ou-nada e entra só pela flag, nunca pelo relógio (ADR-0006): a
mesma linha de comando produz o mesmo Provedor às três da tarde e às três da
manhã, o que mantém duas entradas do `PROGRESS.md` comparáveis sem arqueologia
de horário. A Orientação e o trabalho em código de uma iteração pensam sempre
no mesmo Provedor — `ANTHROPIC_BASE_URL` é variável de processo, não de fase
(ADR-0007); o que continua sendo escolhido por fase é só o modelo.

```jsonc
{
  "nightProvider": {
    // endereço do Ollama a partir de dentro do sandbox; 127.0.0.1/localhost
    // escritos aqui são traduzidos pro host do Docker automaticamente
    "baseUrl": "http://host.docker.internal:11434",
    // padrão — validado nas três provas abaixo na máquina de referência da issue #29
    "model": "qwen3-coder:30b-a3b-q4_K_M",
    // null = herda o modelo acima (ADR-0007); troque só se quiser um modelo
    // menor pra fase que só lê e relata
    "orientationModel": null,
    // por quanto tempo o Ollama mantém o modelo residente; "8h" cobre uma
    // noite inteira e expira sozinho, sem nada persistente escrito
    "keepAlive": "8h",
    // tamanho do prompt que o canário de contexto do doctor precisa provar
    // sem truncar; baixe este valor para aceitar explicitamente menos contexto
    "minContext": 131072,
    // teto de cada prova de /v1/messages do doctor e do aquecimento antes da
    // iteração 1; suba se a máquina é lenta e a espera é aceitável — night
    // mode gasta tempo ocioso, não token pago
    "probeTimeoutSeconds": 900,
    // quantos tokens a iteração pode escrever numa resposta; o padrão do
    // Claude Code (32000) não cabe num modelo que raciocina antes de
    // responder — o raciocínio gasta orçamento e não deixa texto
    "maxOutputTokens": 64000
  }
}
```

O bloco inteiro mora em `DEFAULTS` — sem `nightProvider` no config, `--night`
usa o padrão acima; declarar só um campo (ex.: `{"nightProvider": {"model":
"..."}}`) herda o resto do bloco, sem precisar repeti-lo.

### O que precisa estar de pé no host

O Ralph fala com o Ollama do host de dentro do sandbox Docker. Três coisas
precisam estar configuradas do lado de fora, e **o Ralph não instala, não
baixa e não reconfigura nada do Ollama** — mesma fronteira do índice de
conhecimento (ADR-0001): ele mede e prescreve o comando, o operador decide.

| Do lado do host | Por quê |
|---|---|
| `OLLAMA_HOST=0.0.0.0` | por padrão o Ollama só escuta em `127.0.0.1`, que de dentro do sandbox é o próprio container — sem isso o Provedor é inalcançável |
| `OLLAMA_CONTEXT_LENGTH=131072` (ou o que o repo exigir) | o padrão do Ollama (2048–8192, conforme a versão) trunca o prompt da iteração em silêncio e o modelo responde com confiança sobre o pedaço que sobrou — o canário de contexto do `doctor` é como isso é pego antes de gastar uma iteração |
| `keep_alive` / tempo de residência do modelo | sem residência, cada iteração paga de novo o carregamento de dezenas de GB; é o único campo que o Ralph escreve no Ollama, via `preload()` antes da iteração 1, e ele expira sozinho |

`ollama pull <tag>`, o serviço em si e a escolha de hardware continuam sendo
responsabilidade do operador — não há `ralph index build` equivalente aqui.

### Fluxo recomendado

```bash
ralph doctor --night      # roda as três provas do Provedor local antes de gastar tempo de máquina
ralph once --night        # uma iteração assistida — aprenda como o modelo escolhido se comporta
ralph afk -n 20 --night   # o loop, sem supervisão
```

`--night` no `doctor` é a mesma flag explícita de `once`/`afk` (ADR-0006): sem
ela, a saída fica idêntica à de sempre, mesmo com `nightProvider` no config —
o sinal de "quero as provas agora" é pedir, não ter configurado.

`ralph doctor` roda as mesmas três provas que a primeira iteração de um
`--night` roda sozinha, só que em segundos, antes do loop existir: **alcance**
(a partir do host e do sandbox), **`tool_use` estruturado** (um pedido que só
uma chamada de ferramenta resolve — alguns modelos anunciam a capacidade e
escrevem a chamada como texto solto, e reprovam mesmo assim) e o **canário de
contexto** (um prompt maior que qualquer `num_ctx` padrão do Ollama, que só
aprova se a resposta cita o início do texto e não o fim). O canário lê só os
blocos de texto da resposta, nunca o raciocínio: o modelo que pensa antes de
responder cita as duas senhas enquanto pensa, e aceitar isso apagaria a
distinção que a prova existe para fazer. Resposta vazia por esgotar o orçamento
de saída é reportada como orçamento, não como truncamento. Cada prova tem o teto
que o operador declarou em `nightProvider.probeTimeoutSeconds` (15 minutos por
padrão): uma prova que não conclui nele é reportada como prova incompleta —
o Provedor pode estar íntegro, só lento —, nunca como truncamento. Qualquer
reprovação sai com o comando que conserta. Pular direto para `ralph afk --night` funciona,
mas gasta a primeira noite aprendendo o que `once` teria mostrado num minuto.

### Contenção de GPU com a busca semântica

Se o repositório alvo tem o índice de conhecimento (`code-review-graph`), a
busca semântica dele fala com o mesmo Ollama do host — para embeddings, não
para a inferência da iteração —, e as duas coisas dividem a mesma GPU. Medido
na máquina de referência: o modelo de código (31 GB, 46% GPU) e o de
embeddings (2,4 GB, 100% GPU) coexistem sem despejo, com pouca VRAM de sobra.
É contenção aceita, não um bug — se o operador quiser mais folga, a saída é
reduzir `OLLAMA_CONTEXT_LENGTH`; o Ralph não decide isso por conta própria.

Quando a folga não sobra, a busca semântica degrada em vez de travar a
iteração: `ralph doctor` mostra a linha "busca semântica do
code-review-graph indisponível" enquanto as outras nove tools do índice
continuam funcionando — o mesmo aviso aparece se você rodar `doctor` no meio
de uma noite ocupada.

## Prompt da iteração

`ralph init --prompt <nome>` copia um dos templates de `prompts/` para
`.ralph/prompt.md`:

- **`implement`** (padrão) — consome o backlog de tickets via
  `/mattpocock-skills:implement`
- **`entropy`** — remove duplicação, código morto e padrões inconsistentes, um
  por iteração
- **`test-coverage`** — cobre uma lacuna de teste por iteração, priorizada por
  risco

Os placeholders `{{PROGRESS_FILE}}`, `{{COMPLETION_PROMISE}}`,
`{{BLOCKED_PROMISE}}` e `{{FEEDBACK_LOOPS}}` são substituídos a cada iteração a
partir do config.

`{{SIGNATURE}}` é o quinto, e vem da iteração em vez do config: ele nomeia o
modelo da rodada e o arquivo de log daquela iteração, e os três prompts pedem
que ele feche o comentário do ticket e a mensagem de commit.

```
Ralph · modelo `ornith:9b` (--night) · log `.ralph/logs/2026-09-01T15-10-09-175Z-iter-01.jsonl`
```

Sem isso, saber qual rodada entregou um ticket exige cruzar o horário de
fechamento no tracker com o `gh issue close` de dentro de cada log — e para
uma parte dos tickets não há resposta.

### O prompt instalado é cópia, não rascunho

Cada template carrega no topo a linha `<!-- ralph:prompt <nome> -->`, e a cópia
a herda. É por ela que o Ralph sabe de onde o seu `.ralph/prompt.md` veio, e a
comparação com o template é byte a byte — se o texto divergiu, é porque o Ralph
avançou e o arquivo ficou parado, não porque alguém escolheu isso. `ralph
doctor` diz de qual template ele saiu, e `ralph once`/`ralph afk`
re-sincronizam antes de rodar, avisando o que reinstalaram. `ralph init
--force` sem `--prompt` reinstala o template que o arquivo declara, nunca o
padrão: um alvo em loop de entropia não vira um de implement por causa de uma
re-sincronização.

Duas saídas dessa regra:

- **É seu de propósito** — troque o nome por `custom`
  (`<!-- ralph:prompt custom -->`). O Ralph passa a calar sobre esse arquivo e
  nunca mais o toca; nem `ralph init --force`, que só o sobrescreve se você
  nomear um template (`--force --prompt <nome>`).
- **Não tem a linha nenhuma** — é o caso de todo `.ralph/prompt.md` criado
  antes desta versão. O `doctor` não adivinha a origem: casar por semelhança
  trocaria um loop de entropia por um de implement em silêncio, desfecho pior
  que a deriva. Ele oferece os três caminhos, cada comando numa linha e colável
  como está — `ralph init --force` para o padrão (`implement`), o mesmo com
  `--prompt entropy` para outro, ou o marcador `custom` para assumir o arquivo.

`ralph init` nomeia na saída o template que instalou
(`prompt        .ralph/prompt.md (implement)`). Quando não instalou nada — sem
`--force`, um prompt que já existe fica onde está —, a linha diz `em dia` se o
arquivo já é a cópia fiel, e `preservado` quando há algo a reinstalar.

## Comandos

| Comando | O que faz |
|---|---|
| `ralph init [--prompt <nome>] [--force]` | cria `.ralph/` no repo atual |
| `ralph doctor [--night]` | checa docker, sandbox, plugins, login, versão do `gh` e fonte de tarefas (com `--night`, também o Provedor local) |
| `ralph login [--share-credentials]` | autentica o Claude dentro do sandbox |
| `ralph gh-login [--token[=valor]]` | autentica o `gh` dentro do sandbox |
| `ralph once [--allow-branch] [--night]` | uma iteração (HITL) |
| `ralph afk [-n N] [--allow-branch] [--night]` | o loop (AFK) |
| `ralph status` | últimas entradas do `PROGRESS.md` |
| `ralph shell` | bash dentro do sandbox |
| `ralph bootstrap [--force]` | reinstala plugins/skills no sandbox |
| `ralph sandboxes` / `ralph mounts` / `ralph rm` | inspeção e limpeza |

Opções comuns: `--model <nome>` (com `--night`, sobrescreve
`nightProvider.model` em vez do modelo da API paga), `--prompt <arquivo>`, e
`-- <args>` para repassar argumentos crus ao `claude`. Detalhes de `--night`
em [Night mode](#night-mode).

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
