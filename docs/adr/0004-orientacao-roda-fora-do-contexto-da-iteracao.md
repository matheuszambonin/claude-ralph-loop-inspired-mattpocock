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
rodá-la em haiku em vez de sonnet, mais −$0,26 (−9%). Juntas, −35%.

Pôr `"model": "haiku"` no config economiza −$1,41 (−50%), custa zero linha de
código, e foi **rejeitado**: aí o haiku implementa o ticket. O loop existe para
manter a Orientação barata, não para baratear o trabalho. Quem ler estes
números vai propor a troca global de novo; é este parágrafo que responde.

Também rejeitados: subagente para roteamento (não existe roteamento — o prompt
diz qual fase é qual, e é estático), subagente para formatação (0,2% da conta),
e subagente para os feedback loops — o agente precisa **ver** o erro do teste
para consertá-lo, e um resumo do erro é exatamente o que ele não pode receber.

## Consequences

Subagente não herda o cache do pai. Medido: 16.098 tokens de cache write só
para responder "2+2" — ~$0,02 a $0,03 fixos por invocação. É barato contra os
$0,75, e é o teto de quantas vezes vale delegar: uma.

A whitelist de tools é estrita e é o que segura o custo do subagente: reduzi-la
levou o `subagent_tokens` de 16.192 para 3.728 (−77%). `Bash` sozinho custa
~2k, e `Bash(gh *)` **não** restringe nada — o subagente recebe `Bash` puro.
Sem `Edit` e sem `Write`: quem orienta não escreve.

A medição por modelo vem antes de tudo. A variação natural de uma iteração vai
de $0,22 a $4,11; sem o custo quebrado por modelo no relatório do loop, 26% de
economia é indistinguível de 0%, e as duas decisões acima viram fé.

O haiku tem janela de 200K contra 1M do sonnet. Um repositório grande pode
estourar a janela na Orientação. Não há tratamento: se degradar, troca-se
`scoutModel` para sonnet e ainda sobram os 26%.
