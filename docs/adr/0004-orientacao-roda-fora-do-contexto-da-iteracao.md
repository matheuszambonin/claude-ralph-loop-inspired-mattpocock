# Orientação roda fora do contexto da iteração

A Orientação passa a acontecer num subagente próprio, em haiku, e o que volta
para a iteração é o resumo de orientação — o ticket escolhido e o que ele exige.
O material lido para chegar lá morre com quem o leu.

## Considered Options

Medimos cinco iterações reais em `.ralph/logs/*.jsonl`: média de $2,82 e 118
turnos por iteração. A fatura se reparte assim:

| componente          | tokens/iteração | custo   |     % |
| ------------------- | --------------: | ------: | ----: |
| cache read          |       8.562.363 |   $1,71 | 67,7% |
| cache write         |         323.469 |   $0,81 | 32,0% |
| output              |             571 |  $0,006 |  0,2% |
| input não-cacheado  |           1.248 |  $0,002 |  0,1% |

99,7% do que se paga é contexto sendo relido. O que custa não é o agente
pensar, é o agente carregar. São 72.317 tokens de contexto por turno, e 1k que
entra cedo e fica até o fim custa $0,0237 na iteração inteira.

Isso mata a premissa de que trocar o modelo das tarefas simples economiza:
output é 0,2% da conta. O que economiza é **não carregar**. A Orientação hoje
deixa ~56k no contexto e são relidos pelos ~87 turnos seguintes, para produzir
um resumo que caberia em 3k. Isolá-la num subagente vale −$0,75 (−26%);
rodá-la em haiku em vez de sonnet, mais −$0,26 (−9%). Juntas, −35%. Os três
números são **projeção**: saem da tabela acima, medida antes de o isolamento
existir. A medição com ele rodando está pendente na #49 — até ela fechar, é o
que se esperava economizar, não o que se economizou.

Pôr `"model": "haiku"` no config economiza −$1,41 (−50%), custa zero linha de
código, e foi **rejeitado**: aí o haiku implementa o ticket. O loop existe para
manter a Orientação barata, não para baratear o trabalho. Quem ler estes
números vai propor a troca global de novo; é este parágrafo que responde.

Também rejeitados: subagente para roteamento (não existe roteamento — o prompt
diz qual fase é qual, e é estático), subagente para formatação (0,2% da conta),
e subagente para os feedback loops — o agente precisa **ver** o erro do teste
para consertá-lo, e um resumo do erro é exatamente o que ele não pode receber.

## Consequences

Subagente não herda o cache do pai. A primeira medida — 16.098 tokens de cache
write para responder "2+2", ~$0,02 a $0,03 — pegou o piso, não o caso: "2+2"
não tem contexto para reler, e este ADR existe para dizer que 99,7% da conta é
contexto relido. Uma Orientação de verdade custa **~$0,21 por invocação**; duas
invocações medidas leram 650k e 1,04M de tokens de cache, porque o subagente
relê o próprio contexto a cada turno exatamente como o pai relê o dele.

Continua barato contra os $0,75, e endurece o teto de quantas vezes vale
delegar: uma. Na segunda invocação já se foram $0,42 dos $0,75.

A whitelist de tools é estrita e é o que segura o custo do subagente: reduzi-la
levou o `subagent_tokens` de 16.192 para 3.728 (−77%). `Bash` sozinho custa
~2k, e `Bash(gh *)` **não** restringe nada — o subagente recebe `Bash` puro.
Sem `Edit` e sem `Write`: quem orienta não escreve arquivo. No tracker a
whitelist não alcança — `gh issue close` sai pelo mesmo `Bash` que o `gh issue
list` precisa (issue #77), e ali quem segura é a linha do prompt.

A medição por modelo vinha antes de tudo, e foi feita (`e19db04`). O que falta
é rodar: a variação natural de uma iteração vai de $0,22 a $4,11, e enquanto
poucas iterações não separarem 26% de economia de 0%, as duas decisões acima
seguem sendo fé. A #49 é onde isso fecha.

O haiku tem janela de 200K contra 1M do sonnet. Um repositório grande pode
estourar a janela na Orientação. Não há tratamento: se degradar, troca-se
`orientationModel` para sonnet e ainda sobram os 26%.
