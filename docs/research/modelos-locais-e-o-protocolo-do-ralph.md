# Por que os modelos locais não cumprem o protocolo do Ralph

Nota de pesquisa, 01/09/2026. Investiga três sintomas medidos no repositório alvo
Terraços rodando `ralph once --night` contra o Provedor local.

O veredito curto vem primeiro, porque ele muda o que vale a pena mexer.

| Sintoma | Causa | Configuração conserta? |
|---|---|---|
| Laço de tool call idêntico | capacidade do modelo | não |
| Instrução negativa ignorada | capacidade do modelo | não, mas o Ralph pode ler o veto do lado de fora |
| Varredura de 47 minutos fora do escopo | metade capacidade, metade máquina | em parte, e só a metade da máquina |

Nenhum dos três se explica por truncamento de contexto, por perda na tradução do
formato Anthropic para o do Ollama, ou por `tool_use` mal formado. Todos os três
foram descartados por medição, e a seção "O que foi descartado" mostra como.

## Onde isso foi medido

| Peça | Valor | Fonte |
|---|---|---|
| GPU | RTX 5080, 16302 MiB | `server.log`, `common_memory_breakdown_print` |
| RAM | 125,6 GiB | `server.log`, `sched.go:613` |
| Ollama | 0.33.0 | `GET /api/version` |
| `OLLAMA_HOST` | `0.0.0.0` | `HKCU\Environment` |
| `OLLAMA_CONTEXT_LENGTH` | `131072` | `HKCU\Environment` |
| Claude Code das iterações | 2.1.221 | campo `claude_code_version` do evento `init` dos logs |
| Claude Code da captura de hoje | 2.1.257 | `claude --version` no host |
| Modelo da iteração | `ornith:9b` | `.ralph/config.json` do Terraços |
| Modelo da Orientação | `qwen3-coder:30b-a3b-q4_K_M` na rodada das 20:43Z, `ornith:9b` na das 20:29Z | campo `model` das mensagens do subagente |

Logs citados, todos em `C:\Users\SS1\Documents\Tools\Terraços\.ralph\logs\`:

- `2026-09-01T20-29-56-337Z-iter-01.jsonl`, chamado aqui de **log A** (16:29:56 a
  16:42:43 no relógio local, UTC-4).
- `2026-09-01T20-43-33-423Z-iter-01.jsonl`, chamado aqui de **log B** (16:43:33 a
  17:33:21 local).

O log do servidor Ollama é `C:\Users\SS1\AppData\Local\Ollama\server.log`, 251491
linhas, cobrindo a janela inteira.

## O caminho que um pedido percorre

`renderEnv` em `src/provider.mjs:54` injeta `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` e `CLAUDE_CODE_MAX_OUTPUT_TOKENS` no processo `claude`.
Daí em diante o Claude Code trata o Ollama como um gateway em formato Anthropic
Messages, e a documentação oficial diz exatamente para qual caminho ele posta:
"Inference requests post to `/v1/messages?beta=true`, so match on the path, not
the full URL"
([code.claude.com/docs/en/llm-gateway-protocol](https://code.claude.com/docs/en/llm-gateway-protocol)).

Medido, é isso mesmo. O `server.log` da janela das duas iterações registra 98
respostas 200 em `POST "/v1/messages?beta=true"`, 6 em `POST "/v1/messages"` e 8
respostas **404** em `POST "/v1/messages/count_tokens?beta=true"`.

O Ollama documenta esse endpoint em
[docs.ollama.com/api/anthropic-compatibility](https://docs.ollama.com/api/anthropic-compatibility).
Do lado do modelo, o Ollama 0.33 não usa mais template Go para nenhum dos dois:
`ollama show --modelfile` traz `RENDERER ornith` / `PARSER ornith` e
`RENDERER qwen3-coder` / `PARSER qwen3-coder`, com `TEMPLATE {{ .Prompt }}`. O
`server.log` confirma na carga do modelo:

```
msg="template selection" model=registry.ollama.ai/library/ornith:9b selected=renderer_parser renderer=ornith parser=ornith go_template=null
```

### O que o Claude Code manda de verdade

Interpus um proxy que registra o corpo de cada pedido entre o Claude Code e o
Ollama, e rodei uma sessão `claude --print --model ornith:9b` com um subagente
declarado por `--agents`, do mesmo jeito que `src/orientation.mjs` declara a
Orientação. O corpo de um pedido de inferência do processo principal:

| Campo | Valor enviado | O Ollama honra? |
|---|---|---|
| `model` | `ornith:9b` | sim |
| `max_tokens` | `64000` | sim |
| `stream` | `true` | sim |
| `system` | 3 blocos, 74 + 62 + 6919 caracteres | sim |
| `tools` | 31 ferramentas | sim |
| `thinking` | `{"type":"adaptive"}` | sim, como raciocínio ligado |
| `cache_control` | `{"type":"ephemeral"}` em 2 dos 3 blocos de `system` e em 3 pontos de `messages` | **não** |
| `context_management` | `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` | **não** |
| `output_config` | `{"effort":"high"}` | **não** |
| `metadata` | presente | **não** |
| `tool_choice` | ausente nesta amostra | **não**, se viesse |
| cabeçalho `anthropic-beta` | 9 capacidades, de `interleaved-thinking-2025-05-14` a `structured-outputs-2025-12-15` | nenhuma |

A coluna da direita sai da tabela "Unsupported features" da própria documentação
do Ollama, que lista `/v1/messages/count_tokens`, `tool_choice`, `metadata`,
"Prompt caching (`cache_control` blocks for caching prefixes)", Batches, Citations
e PDF. O Ollama não recusa nenhum desses campos, ele os ignora. É a pior das duas
saídas para quem depura, e a documentação do Claude Code descreve o efeito com
precisão para o caso do cache: "No error: the conversation bills as uncached input
on every turn, visible as high `input_tokens` with little or no cache activity in
`usage`".

Foi exatamente o que aconteceu. O recibo da Orientação do log B, linha 238, traz
`"input_tokens":115948,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":751`
depois de 33 chamadas de ferramenta. Zero cache em 116 mil tokens de entrada.

### Onde a tradução perde informação

Três perdas reais, medidas ou lidas no código-fonte do Ollama.

**Esquema de ferramenta, só no `qwen3-coder`.** O renderizador
[`model/renderers/qwen3coder.go`](https://github.com/ollama/ollama/blob/main/model/renderers/qwen3coder.go)
reescreve cada ferramenta campo a campo em XML (`<tools><function><name>…`), e nessa
reescrita `enum` e `required` não têm tratamento nenhum. O modelo recebe os nomes e
os tipos dos parâmetros, e não recebe quais são obrigatórios. O
[`model/parsers/qwen3coder.go`](https://github.com/ollama/ollama/blob/main/model/parsers/qwen3coder.go)
faz o caminho de volta com coerção por precedência, "boolean -> integer -> number
-> array -> object -> string", devolvendo o primeiro tipo que casa. O `ornith`
não sofre disso: ele herda o renderizador `qwen35`, que emite o esquema JSON
inteiro dentro de `<tools>`.

**Raciocínio, só no `qwen3-coder`.** O modelo não tem a capacidade `thinking`
(`ollama show` lista só `completion` e `tools`), e o card do Qwen diz o motivo:
"supports only non-thinking mode and does not generate `<think></think>` blocks
in its output"
([huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct)).
O Claude Code manda `thinking` assim mesmo, porque, segundo a documentação do
gateway, ele "treats model names it doesn't recognize, such as gateway aliases,
as current models that receive the field". O Ollama engole em silêncio, 37 vezes
na janela do log B:

```
level=WARN source=routes.go:2625 msg="model does not support thinking, relaxing thinking to nil" model=qwen3-coder:30b-a3b-q4_K_M
```

**Contagem de tokens.** As 8 respostas 404 em `/v1/messages/count_tokens` deixam o
Claude Code no caminho que a documentação chama de degradado: "Claude Code falls
back to counting context usage through the messages endpoint". Junto com o
`context_management` ignorado, isso significa que nada apara o contexto da
Orientação enquanto ele cresce.

Nenhuma dessas três perdas explica os três sintomas. Elas são o custo real de
rodar o protocolo do Ralph num Provedor local, e valem como registro. A
documentação do Claude Code, aliás, já avisa em uma frase: "Anthropic doesn't
endorse, maintain, or audit third-party gateway products, and doesn't support
routing Claude Code to non-Claude models through any gateway"
([code.claude.com/docs/en/llm-gateway](https://code.claude.com/docs/en/llm-gateway)).

## Sintoma 1: o laço de tool call idêntico

### O que o log mostra

No log A, o subagente `orientation` rodando `ornith:9b` emitiu
`git show 017d6bc --stat 2>&1` dez vezes, nas linhas 135, 138, 141, 144, 147,
150, 153, 156, 159 e 162. O `tool_result` de cada uma tem os mesmos 2087
caracteres, com o mesmo commit. O `input_tokens` do modelo cresce 889 tokens por
repetição, de 37686 na primeira para 44794 na décima. O modelo viu o resultado
idêntico nove vezes antes de pedir a décima. O detector do
`src/stream.mjs:61` cortou a iteração ali, e o log A termina na linha 162 sem
evento `result`.

### O que descartei

**Não é penalidade de repetição mal configurada.** O `server.log` registra os
parâmetros do amostrador em cada carga de slot. Para o `ornith:9b`:

```
repeat_last_n = 64, repeat_penalty = 1.000, frequency_penalty = 0.000, presence_penalty = 0.000
top_k = 20, top_p = 0.950, ... temp = 0.600
```

O `repeat_penalty` é 1.000 porque nem o Modelfile do `ornith` nem o pedido o
declaram, e o padrão do llama.cpp é 1.0. Só que ligá-lo não ajudaria: o
`repeat_last_n` é 64 tokens, e cada repetição está separada da anterior por 889
tokens. A janela da penalidade não alcança a repetição. Para o `qwen3-coder` o
Modelfile declara `repeat_penalty 1.05`, e ele repetiu do mesmo jeito.

**Não é o raciocínio desligado.** Essa era a hipótese com melhor cara. O censo de
blocos por fase mostra que o subagente `orientation` não emite bloco `thinking`
nenhum em toda rodada desde 28/08/2026 19:06Z, enquanto o processo principal
emite em quase todo turno. A quebra é exata e coincide com o commit `952e42c`,
que passou a mandar `run_in_background: false` na chamada da Orientação.

A captura de hoje mostra que a leitura estava errada. No caminho síncrono o
Claude Code manda `thinking: {"type":"adaptive","display":"omitted"}`; no
assíncrono manda `thinking: {"type":"adaptive"}`. O raciocínio continua ligado
nos dois. O que muda é se os blocos aparecem no stream. Vinte e cinco pedidos do
subagente síncrono da captura carregam `display: "omitted"`, e trinta do
assíncrono não carregam.

### A reprodução

Hoje, fora do Ralph, com o Claude Code 2.1.257 apontado para o mesmo Ollama:
um subagente com **uma** ferramenta (`Read`), um prompt de uma linha
("Report back."), um contexto de 2029 tokens e o raciocínio ligado. O
`ornith:9b` leu um `CLAUDE.md` inexistente **84 vezes seguidas**, recebendo as 84
vezes o mesmo `File does not exist`, e escrevendo antes de cada uma um bloco de
raciocínio que parafraseia a mesma frase ("The user said 'Report back.' which is
vague. Let me check what's happening in the working directory").

A segunda rodada, dessa vez pelo caminho síncrono, repetiu `Read AGENT.md` dez
vezes e `Read AGENTS.md` dez vezes, arquivos que também não existem.

Não há contexto longo, não há tradução complicada, não há ferramenta ambígua e
não há resultado ambíguo. O modelo não atualiza o estado dele diante de um
resultado negativo repetido. **É capacidade, e nenhuma configuração conserta.**

## Sintoma 2: a instrução negativa ignorada

### A regra chegou

`.ralph/prompt.md` do Terraços, linha 51, no arquivo salvo às 16:33 local, dez
minutos antes da rodada do log B:

> A `CLAIM` that adds a triage label is not a claim, it is the report promoting
> its own ticket: don't run it, emit `<promise>{{BLOCKED_PROMISE}}</promise>` and
> stop.

O `{{BLOCKED_PROMISE}}` vira `BLOCKED` na substituição que o `runner` faz a cada
iteração.

E `prompts/orientation.md` deste repositório, no bloco do contrato:

> Never invent one, and never a command that applies a triage label — that
> promotes the ticket onto the frontier, it does not claim it.

Os dois arquivos estavam em disco antes da rodada. O prompt não foi truncado: a
seção "O que foi descartado" mostra que nenhum pedido da janela sofreu corte.

### O que os dois modelos fizeram

A Orientação (`qwen3-coder:30b`) devolveu, no log B linha 238:

```
STATUS: ready
TICKET: #19 A jusante em gradiente encosta no escoadouro, ou o terraço é recusado
CLAIM: gh issue edit 19 --add-label "ready-for-agent"
```

Compôs exatamente o comando que o prompt dela proíbe compor. Pior, a issue #19
estava **fechada**. A prova está no log A, linha 115, onde a mesma consulta
devolve `"number":19,"state":"CLOSED"`; e na linha 109, onde
`gh issue list --state open` devolve só as issues 21 e 12.

A Orientação do log B nunca chegou a consultar o estado. Ela rodou
`gh issue view 19 --comments` (linhas 148 e 205), que imprime comentários e não
imprime `state`, e `gh issue list --state open` (linha 142), cujo resultado não
contém a #19. Montou "a #19 está aberta e pronta" a partir da prosa do
`PROGRESS.md` e dos comentários. É literalmente o parágrafo que o prompt
adicionou no commit `489bcac`, ignorado.

A iteração (`ornith:9b`) recebeu o relatório, recitou o `CLAIM` no bloco de
raciocínio da linha 464 sem mencionar a proibição uma única vez, e rodou o
comando na linha 465. O `tool_result` da linha 466 é a URL da issue, ou seja, o
rótulo foi aplicado de fato.

E o desfecho é o retrato do problema. Na linha 1404 a própria iteração rodou
`gh issue view 19` e leu `state: CLOSED`. Ela repetiu isso mais de vinte vezes
ao longo das 5000 linhas seguintes ("The issue is CLOSED", "The work was already
done"), nunca emitiu a promise de bloqueio que o passo 2 do prompt manda emitir,
e terminou escrevendo quatro entradas duplicadas no `PROGRESS.md` (linhas 5701,
5926, 6391 e 6571).

**É capacidade.** A regra estava no contexto, em inglês, a poucos parágrafos da
ação. Mas aqui, diferente do sintoma 1, o Ralph tem uma correção estrutural
disponível, e ela está no fim desta nota.

## Sintoma 3: a varredura de 47 minutos

A Orientação do log B durou `totalDurationMs: 2812046`, ou 46 minutos e 52
segundos, em 33 chamadas de ferramenta. Ela leu `docs/PENDENCIAS.md` (54 KB),
`CONTEXT.md` (14 KB), três ADRs, `terracos/core/ends.py` (30 KB),
`terracos/core/dem.py` e `terracos/processing/locate.py`, tudo depois da linha do
prompt que diz "Do not survey the whole codebase". O contexto dela saiu de 9570
tokens e chegou a 115948.

Quanto disso é o modelo desobedecendo e quanto é a máquina, dá para separar.

### A máquina

O `qwen3-coder:30b-a3b-q4_K_M` não cabe nesta GPU com o contexto declarado. O
`server.log`, na carga das 16:43:46, mede:

```
common_params_fit_impl: projected to use 30024 MiB of device memory vs. 14985 MiB of free device memory
common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 16063 MiB
common_params_fit_impl: getting device memory data with all MoE tensors moved to system memory:
```

O resultado é que os pesos dos especialistas foram para a RAM do host:

```
load_tensors:        CUDA0 model buffer size =  1264.92 MiB
load_tensors:    CUDA_Host model buffer size = 16426.42 MiB
```

Com 16,4 GB de peso na RAM, o processamento de prompt caiu para 33 tokens por
segundo, medido:

```
slot print_timing: id  0 | task 1845 | prompt processing, n_tokens = 9216, progress = 0.89, t = 275.10 s / 33.50 tokens per second
```

O card do Qwen recomenda reduzir o contexto para 32768 em máquina apertada, e a
documentação do Ollama diz o mesmo por outro lado: use "the maximum context
length for a model, and avoid offloading the model to CPU"
([docs.ollama.com/context-length](https://docs.ollama.com/context-length)).

### Os três streams abortados

Na janela das duas iterações, três pedidos morreram com 500:

```
[GIN] 2026/09/01 - 17:12:37 | 500 |         4m49s | ::1 | POST "/v1/messages?beta=true"
[GIN] 2026/09/01 - 17:17:38 | 500 |          5m0s | ::1 | POST "/v1/messages?beta=true"
[GIN] 2026/09/01 - 17:23:39 | 500 |         4m24s | ::1 | POST "/v1/messages?beta=true"
```

Não há uma linha `level=ERROR` no `server.log` da janela inteira. O que há é a
documentação do gateway do Claude Code descrevendo o watchdog:

> Claude Code counts every byte your gateway relays, including SSE `ping` events
> and comment lines, and aborts a stream that goes silent for 300 seconds by
> default. [...] An upstream that sends no pings at all [...] leaves those pauses
> with nothing to forward.

E o Ollama não manda ping durante o processamento de prompt. Medi hoje: um prompt
de 412500 caracteres, uns 114 mil tokens, mandado ao `ornith:9b` com
`stream: true`, ficou **16803 ms sem um único byte** e devolveu **zero** eventos
`ping`. O `ornith` cabe na GPU e engoliu isso em 17 segundos. A 33 tokens por
segundo do `qwen3-coder`, o mesmo prompt são 57 minutos de silêncio, e os
primeiros 300 segundos já bastam.

Os três abortos batem com três buracos no log B. Entre dois turnos consecutivos
da Orientação há um vão de 652 s às 21:18:39Z, que cobre os abortos das 17:12 e
17:17 local, e outro de 379 s às 21:25:34Z, que cobre o das 17:23. Somados, os
buracos longos do log B dão 2034 s, 36 minutos dos 47.

O aborto das 4m24s fica abaixo dos 300 s, então ou o watchdog contou a partir de
um byte anterior, ou aquele caso teve outra causa. Chamo o mecanismo de
inferência, não de medição, e a seção seguinte diz o que o provaria.

### O modelo

O resto é o modelo. Nenhum aborto explica ler `PENDENCIAS.md` inteiro, e nenhum
explica reler três vezes o mesmo `gh issue list` com o mesmo `grep`.

## O que foi descartado, e com que medida

**Truncamento de contexto.** Nenhum. O `server.log` recortado na janela das duas
iterações (linhas 239990 a 245474) traz 107 linhas `slot release`, todas com
`truncated = 0`. O maior prompt da janela mediu `task.n_tokens = 115948`, contra
`n_ctx_slot = 131072`. O truncamento existe neste servidor e aparece no log
quando acontece, sempre em `n_tokens = 131071` com `truncated = 1`, e as
ocorrências mais recentes são das 17:41 local, depois do fim do log B, no canário
do `ralph doctor`. O canário de `src/provider.mjs:315` está fazendo o trabalho
dele, e nas duas iterações não havia o que ele pega.

**System prompt cortado.** Não. O primeiro turno do processo principal do log A
já reporta `input_tokens: 34728`, e o primeiro turno da Orientação reporta
9559. A captura de hoje mostra o `system` chegando como 3 blocos separados, com
6919 caracteres no terceiro, e o `tools` com 31 entradas.

**`tool_use` estruturado quebrado.** Não. Rodei a mesma sonda que
`src/provider.mjs:83` roda, contra o `ornith:9b`, e voltou
`"stop_reason":"tool_use"` com um bloco `tool_use` de `input` correto. O modo
streaming também fecha com `message_delta` trazendo `{"delta":{"stop_reason":"tool_use"}}`.
Os identificadores vêm no formato do Ollama (`call_1p3soaon` no log A linha 162,
em vez do `toolu_` da Anthropic), e nada no Claude Code se importa com isso.

**Perda de esquema de ferramenta.** Real para o `qwen3-coder`, e sem efeito aqui.
As ferramentas que a Orientação usa (`Read`, `Grep`, `Glob`, `Bash`, pela lista
branca de `src/orientation.mjs:16`) não dependem de `enum`, e o `required` que se
perde não muda um `Bash` de um argumento só.

**Modelo carregado errado ou parâmetro fora do card.** Não. Os parâmetros do
amostrador registrados no `server.log` batem com o Modelfile e com os dois cards.
O `ornith` roda com temperatura 0,6, `top_p` 0,95 e `top_k` 20, e o card recomenda
"temperature=0.6, top_p=0.95, top_k=20"
([huggingface.co/ornith-ai/Ornith-1.0-9B](https://huggingface.co/ornith-ai/Ornith-1.0-9B)).
O `qwen3-coder` roda com 0,7 / 0,8 / 20 / 1,05, exatamente o que o card do Qwen
recomenda. Ambos declaram 262144 de contexto de treino e rodam em 131072, o que o
llama.cpp anota como "the full capacity of the model will not be utilized" e não
como erro.

## Medido contra inferido

Medido:

- os dez `git show` idênticos e o crescimento de 889 tokens entre eles;
- as 84 e as 10+10 repetições reproduzidas hoje, fora do Ralph, com uma
  ferramenta e 2 mil tokens de contexto;
- `thinking: {"type":"adaptive","display":"omitted"}` no subagente síncrono e
  `{"type":"adaptive"}` no assíncrono;
- `cache_read_input_tokens: 0` sobre 115948 tokens de entrada;
- as 8 respostas 404 em `/v1/messages/count_tokens`;
- as 37 linhas `relaxing thinking to nil` para o `qwen3-coder`;
- os 16,4 GB de especialistas na RAM do host e os 33 tokens por segundo;
- os 16803 ms de silêncio e zero pings num prompt de 114 mil tokens;
- zero truncamento em 107 conclusões de slot na janela;
- a #19 fechada, e o comando que a Orientação usou não trazendo o campo `state`.

Inferido:

- que os três 500 são o watchdog de 300 s do Claude Code cortando um stream mudo.
  O que provaria: pôr um proxy que registre o instante de cada byte entre o
  sandbox e o Ollama numa rodada com o `qwen3-coder`, e ver se o corte cai
  exatamente 300 s depois do último byte. O que o desmentiria: uma linha de erro
  do Ollama coincidindo com o horário, que não existe no log de hoje.
- que a captura feita no host com o Claude Code 2.1.257 representa o que o 2.1.221
  do sandbox manda. Os campos observados são estáveis entre versões, mas o nome
  da ferramenta mudou (`Task` no 2.1.221, `Agent` no 2.1.257), então há diferença
  entre as duas. O que provaria: repetir a captura de dentro do sandbox.

## O que mudar, em ordem de custo

**1. Trocar `nightProvider.orientationModel` para `ornith:9b`. Custo zero.**
Prova que a lentidão sai de cena: o `ornith:9b` cabe inteiro na GPU com 131072 de
contexto (`ollama ps` mostra 9,6 GB, 100% GPU), então o processamento de prompt
volta para a casa dos 1500 tokens por segundo e o silêncio nunca chega aos 300 s.
Não prova nada sobre o laço: o log A é uma Orientação em `ornith:9b`, e ela
travou em dez repetições.

**2. Ler o `CLAIM` do lado de fora, como o Ralph já lê o `STATUS`. Custo baixo,
código do Ralph.** O `src/stream.mjs:123` já extrai o `STATUS` do relatório e o
`runIteration` já corta a iteração em `blocked` e `complete`, justamente porque
"um modelo pequeno não ignora o que acabou de ler" (comentário do
`src/stream.mjs:105`). O mesmo remédio serve aqui: extrair o `CLAIM`, recusar o
que casa com `--add-label` ou com o verbo de rótulo do tracker, e tratar isso
como relatório malformado. Prova que a proibição para de depender do modelo
obedecer. Não prova que a Orientação vai parar de compor o comando errado, e não
prova nada sobre o ticket fechado.

**3. Conferir o estado do ticket do lado de fora. Custo baixo, código do Ralph.**
Mesma família do item 2. Com o `TICKET` em mãos, o Ralph consegue rodar a consulta
que o `docs/agents/issue-tracker.md` prescreve e recusar um relatório `ready`
sobre um ticket fechado, antes de a iteração tocar no repositório. Prova que a
rodada do log B não teria acontecido. Não prova que a Orientação vai escolher o
ticket certo quando houver um.

**4. Baixar `minContext` e `OLLAMA_CONTEXT_LENGTH` para 65536. Custo baixo,
configuração do host.** O card do Qwen recomenda 32768 em máquina apertada, e o
KV de 12288 MiB do `qwen3-coder` cai pela metade. Prova que sobra VRAM. Não
resolve o `qwen3-coder` nesta placa: os pesos sozinhos são 17,7 GB, acima dos
16302 MiB da RTX 5080, então os especialistas continuam na RAM e a lentidão
continua. Vale como folga para a busca semântica do índice de conhecimento, não
como conserto.

**5. Apertar `ORIENTATION_LOOP_LIMIT`. Custo baixo, e com preço.** O teto de 10
gastou 12 minutos do log A antes de cortar. As iterações que entregaram nunca
repetiram mais de 2 vezes a mesma chamada, então 4 ou 5 ainda tem folga. Prova
que o laço custa menos tempo. Não prova nada sobre a iteração acertar, e aumenta
o risco de cortar uma leitura legítima.

**6. Trocar de modelo. Custo alto, e não há candidato medido.** Os dois modelos
instalados falham. O `ornith:9b` trava em laço com uma ferramenta e 2 mil tokens
de contexto. O `qwen3-coder:30b` não cabe nesta GPU com contexto útil, e reporta
`ready` sobre um ticket fechado a partir de prosa. O card do `ornith` diz que ele
"serves comfortably on a single 80GB GPU" com vLLM ou SGLang e prefix caching
ligado, o que é o dobro da VRAM desta máquina e um servidor que não é o Ollama.
Nada nas medições de hoje sugere que existe uma tag do Ollama que rode em 16 GB e
cumpra o protocolo.

## A conclusão que não tem enfeite

O protocolo do Ralph pede três coisas de um modelo: parar de repetir uma chamada
quando o resultado não muda, obedecer a uma proibição escrita em prosa a poucos
parágrafos da ação, e não fazer o que o prompt diz para não fazer quando o
contexto está cheio de coisa interessante. Os dois modelos locais medidos hoje
falham nas três, e falham em condições onde não sobra desculpa: contexto de 2 mil
tokens, uma ferramenta, raciocínio ligado, resultado de erro inequívoco.

A configuração muda quanto tempo a falha custa. Ela não muda a falha. O que o
Ralph pode fazer é o que ele já fez com o `STATUS` na issue #79: tirar a decisão
do modelo e pôr do lado de fora, onde uma comparação de string decide. Cada regra
do prompt que sobreviver a essa mudança é uma regra que não depende de o modelo
local ser melhor do que ele é.
