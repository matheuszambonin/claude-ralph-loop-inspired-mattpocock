# Orientação roda fora do contexto da iteração

A Orientação passa a acontecer num subagente próprio, em haiku, e o que volta
para a iteração é o resumo de orientação — o ticket escolhido e o que ele exige.
O material lido para chegar lá morre com quem o leu.

## Considered Options

Trinta e três iterações cobradas rodaram sem o isolamento, todas com o Ralph
como repositório alvo, entre 24 e 27/08/2026. Média de $3,0849 e 112,3 passos do
modelo por iteração. A fatura se reparte assim:

| componente         | tokens/iteração |  custo |     % |
| ------------------ | --------------: | -----: | ----: |
| cache read         |       5.380.090 | $1,646 | 53,4% |
| cache write        |         161.076 | $0,832 | 27,0% |
| output             |          41.459 | $0,600 | 19,5% |
| input não-cacheado |           2.893 | $0,002 |  0,1% |

Os tokens saem do `modelUsage` do evento de resultado, que é o rollup por modelo
e a origem do `total_cost_usd`. A primeira versão desta tabela somava o `usage`
de cada evento do stream, que repete o cache a cada chunk e reporta output
parcial: contava cache read por 1,9 vezes e output por 1/80. Foi de lá que saiu
a frase, agora removida, de que output era 0,2% da conta. O preço por token foi
ajustado por mínimos quadrados sobre os 40 logs cobrados e reproduz a média real
com erro de 0,1%.

Oitenta por cento do que se paga é contexto sendo relido. O que custa não é o
agente pensar, é o agente carregar: são 47.908 tokens relidos por passo do
modelo, e 1k que entra cedo e fica até o fim custa $0,034 na iteração inteira.
Mas output não é ruído. Um quinto da conta sai por ali, e nenhum argumento pode
tratar a escolha de modelo como irrelevante alegando que output não pesa.

A Orientação deixa ~56k no contexto e são relidos por todos os passos seguintes,
para produzir um resumo que caberia em 3k. É esse desperdício que o isolamento
ataca, e a seção seguinte diz o que ele entregou.

Pôr `"model": "haiku"` no config economizaria −69% sobre os mesmos tokens, custa
zero linha de código, e foi **rejeitado**: aí o haiku implementa o ticket. O
loop existe para manter a Orientação barata, não para baratear o trabalho. Quem
ler estes números vai propor a troca global de novo, e é este parágrafo que
responde. Ele responde admitindo o preço da escolha, não negando que exista: a
versão anterior deste ADR rejeitava a troca dizendo que output era 0,2% da conta
e que trocar modelo não economizava, e as duas coisas eram falsas. Cache read e
cache write são cobrados por modelo como o output, então a troca escala a conta
inteira pela razão de preço.

Também rejeitados: subagente para roteamento (não existe roteamento — o prompt
diz qual fase é qual, e é estático), subagente para formatação (um quinto da
conta, mas formatar não é o que enche o contexto), e subagente para os feedback
loops — o agente precisa **ver** o erro do teste para consertá-lo, e um resumo
do erro é exatamente o que ele não pode receber.

## Consequences

### O que a medição fechou

Cinco iterações cobradas rodaram com a Orientação de fato isolada, no mesmo
alvo, entre 25 e 27/08/2026:

| log              |  custo | passos | $/passo | subagente |
| ---------------- | -----: | -----: | ------: | --------: |
| 2026-08-25T14-21 | $4,194 |    170 | $0,0247 |   $0,2079 |
| 2026-08-26T18-15 | $3,059 |    175 | $0,0175 |   $0,2121 |
| 2026-08-27T13-03 | $1,587 |    158 | $0,0100 |   $0,3334 |
| 2026-08-27T13-11 | $1,345 |    106 | $0,0127 |   $0,1859 |
| 2026-08-27T13-43 | $2,509 |    132 | $0,0190 |   $0,2146 |

Contra as 33 sem isolamento:

| métrica            |       controle (n=33) |        isolado (n=5) | efeito |        |
| ------------------ | --------------------: | -------------------: | -----: | -----: |
| custo por passo    | $0,02638 (sd 0,00498) | $0,01678 (sd 0,00570) | −36,4% | t=3,95 |
| custo por iteração |   $3,0849 (sd 1,6402) |  $2,5388 (sd 1,1556) | −17,7% | t=0,71 |
| passos do modelo   |       112,3 (sd 45,1) |      148,2 (sd 28,9) | +32,0% | t=1,72 |

O mecanismo está confirmado. Cada passo do modelo custa 36% menos quando a
Orientação não deixa no contexto o que leu, e com n=33 contra n=5 isso não é
ruído.

A economia prometida na fatura não está. Os −17,7% por iteração não se
distinguem de zero nesta amostra, e a projeção de −26% que este ADR trazia antes
saía da tabela errada acima, não de iteração nenhuma.

A diferença entre as duas linhas está na terceira. A iteração isolada dá 32%
mais passos, e isso devolve quase tudo que o passo mais barato economiza. A
leitura óbvia é que o contexto principal perdeu o material que a Orientação leu
e relê parte dele por conta própria. Fica como hipótese e não como causa, porque
t=1,72 com n=5 também é compatível com acaso. Medi-la exige iterações cobradas
depois de 28/08, e não existe nenhuma.

### O custo do subagente

Subagente não herda o cache do pai. A primeira medida — 16.098 tokens de cache
write para responder "2+2", ~$0,02 a $0,03 — pegou o piso, não o caso: "2+2" não
tem contexto para reler, e este ADR existe para dizer que quatro quintos da
conta é contexto relido. Uma Orientação de verdade custou de **$0,186 a $0,333
por invocação**, média $0,231 em cinco medições, porque o subagente relê o
próprio contexto a cada passo exatamente como o pai relê o dele.

O teto de quantas vezes vale delegar continua sendo uma, por um argumento
diferente do original. Antes, a segunda invocação comia metade de uma economia
conhecida. Agora o custo de delegar está medido e é certo, e a economia por
iteração não está demonstrada: gastar $0,23 certos contra retorno não provado
não escala em direção nenhuma.

A whitelist de tools é estrita e é o que segura o custo do subagente: reduzi-la
levou o `subagent_tokens` de 16.192 para 3.728 (−77%). `Bash` sozinho custa
~2k, e `Bash(gh *)` **não** restringe nada — o subagente recebe `Bash` puro.
Sem `Edit` e sem `Write`: quem orienta não escreve arquivo. No tracker a
whitelist não alcança — `gh issue close` sai pelo mesmo `Bash` que o `gh issue
list` precisa (issue #77), e ali quem segura é a linha do prompt.

### A decisão valer no papel não faz a Orientação rodar isolada

Depois do commit que introduziu o isolamento, a delegação aconteceu assim, por
dia, somando todos os repositórios alvo:

```
25/08    1/15     7%
26/08    1/17     6%
27/08    3/5     60%
28/08   20/20   100%
01/09   15/15   100%
02/09    5/5    100%
```

Nos dois primeiros dias a iteração se orientou sozinha em 30 de 32 vezes. Quem
medir custo com log de 25 ou 26/08 vai concluir que o isolamento não economiza
nada, e vai estar certo sobre aqueles logs e errado sobre a decisão. Recortar a
amostra por data em vez de por delegação observada apaga o efeito inteiro: pelo
critério da data, o custo por passo sobe 4,7%.

As quarenta iterações seguidas desde 28/08 são quase todas night mode. Elas
provam que o mecanismo dispara e não dizem nada sobre custo.

### Procedência

A amostra é: repositório alvo Ralph, provedor cobrado, iteração que chegou à
escolha de ticket. O provedor cobrado se reconhece pelo nome do modelo começar
em `claude-`, e não pelo campo `provider`, que o log marca como `firstParty`
mesmo rodando Ollama e ainda inventa um custo aplicando a tabela de preço da
Anthropic (issue #68). A iteração bloqueada antes de escolher ticket sai da
amostra porque mede sandbox quebrado e não custo de trabalho; a regra vale para
os dois braços.

Os logs vivem em `.ralph/logs/` do alvo, que o `ralph init` põe no `.gitignore`.
Os números desta página são a única cópia que sobrevive a eles.

O haiku tem janela de 200K contra 1M do sonnet. Um repositório grande pode
estourar a janela na Orientação. Não há tratamento: se degradar, troca-se
`orientationModel` para sonnet, e o que se perde é o passo 36% mais barato.
