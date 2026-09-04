# O canário mede o próprio tamanho e nunca reescala

O canário de contexto pergunta ao Provedor quantos tokens ele conta antes de
montar o prompt grande, e monta um só. A conversão de `minContext` em
caracteres deixa de sair de uma constante e passa a sair de dois pedidos de
calibragem contra o Provedor que vai ser sondado.

As duas metades estão no mesmo título porque são a mesma decisão. Medir antes é
o que torna o reescalar desnecessário, e separá-las convidaria a implementar o
reescalar depois, que é o desenho que esta decisão rejeita.

## Considered Options

A constante era `CANARY_CHARS_PER_TOKEN = 45000 / 11000` ≈ 4,091, medida na
máquina de referência da issue #29. Medida de novo, ela erra sempre na direção
que o comentário ao lado dela dizia querer evitar:

| modelo | razão real | prompt de `minContext` 131072 | provado |
|---|---|---|---|
| `qwen3-coder:30b-a3b-q4_K_M` | 4,41 | 536.370 chars | 121.592 tokens (92,8%) |
| `ornith:9b` | 5,353 | 536.370 chars | 100.201 tokens (76,4%) |

**Recalibrar a constante** foi rejeitado por causa dessas duas linhas juntas. As
razões não divergem por erro de medição, divergem porque a razão é propriedade
do tokenizer do modelo. Escrever 5,353 no lugar de 4,091 transfere o erro para o
próximo modelo, e num modelo de razão 4,4 ela estouraria 21% e faria o canário
acusar de truncamento um Provedor correto. Não existe constante certa para
escrever ali.

**Reescalar e repetir** o pedido quando a medida não bate foi rejeitado pelo
custo: o prefill de um pedido de 131k tokens levou 2153s na medição da issue
#54, e repeti-lo dobra a prova mais cara que o Ralph faz antes de qualquer
trabalho útil.

## Como a medida é tirada

Dois pedidos de `CANARY_UNIT` repetido puro, sem senha e sem pergunta, com 4 mil
e 8 mil caracteres, `max_tokens: 1` nos dois. A razão é a diferença de
caracteres dividida pela diferença das duas contagens de `usage.input_tokens`.

Dois pontos e não um porque o `input_tokens` de um pedido traz o envelope do
chat junto (template do modelo, marcadores de papel, system prompt injetado),
que não é filler. O envelope é idêntico nos dois pedidos e some na subtração.

O alvo do prompt grande é `minContext` menos o orçamento de saída, não o
declarado cheio. O `num_ctx` do Ollama cobre prompt mais resposta, então um
prompt de exatamente `minContext` estoura no Provedor cujo
`OLLAMA_CONTEXT_LENGTH` bate com o declarado — o par que a prosa de truncamento
prescreve. Ele truncaria a frente e reprovaria por integridade que tem.

**E o envelope sai do alvo também.** A triagem o supunha de 10 a 20 tokens.
Medido contra `devstral:24b` no Ollama 0.33.0, ele são **1226** — um system
prompt inteiro que o template do modelo injeta, maior que os 1024 tokens que o
alvo reserva. Sem descontá-lo, um alvo de 3072 saiu como prompt de 4341: 41%
acima do pedido e acima do próprio `minContext` declarado, que é exatamente a
truncagem que o alvo existe para evitar. Ele também é medido, não estimado, pela
mesma razão de todo o resto: é propriedade do template do modelo, e o próximo
modelo tem outro.

Medido depois do conserto, com a sonda de verdade contra o Ollama deste host:

| modelo | `minContext` | alvo | provado |
|---|---|---|---|
| `devstral:24b` | 4096 | 3072 | 3096 |
| `devstral:24b` | 32768 | 31744 | 31761 |
| `gpt-oss:20b` | 8192 | 7168 | 7186 |

Dois tokenizers, três tamanhos, sempre dentro da banda entre o alvo e o
declarado. Antes do conserto o primeiro caso fechava em 4341.

## Consequences

`contextTokens` entra no resultado da sonda: os tokens que a prova alcançou, ou
`null` quando não deu para medir. Número e não booleano porque é a única
capacidade do Provedor que o `doctor` mede em vez de repetir do config, e a
linha verde passa a dizer o provado contra o declarado.

**`contextTokens` só se pronuncia com `contextOk` verdadeiro.** Um servidor que
trunca reporta o `input_tokens` de depois do corte, então "menos tokens que o
alvo" seria ambíguo entre a sonda ter se medido mal e o servidor ter cortado. A
senha do início desempata, e é para isso que ela existe.

A conferência é piso, não intervalo: mais tokens que o pedido, com a senha do
início na resposta, é o Provedor provando mais do que foi exigido. O piso
desconta meio por cento do alvo, e esse número não é gosto — a razão sai da
divisão de dois inteiros e carrega a resolução da própria calibragem, uns 0,2%
com amostras de 4 e 8 mil caracteres. Em simulação isso põe a prova 41 tokens
abaixo do alvo num Provedor de razão 4,41 com 131072 declarados, e um piso cru
reprovaria por arredondamento. Meio por cento cobre a resolução com folga de
duas vezes e ainda pega os 7,3% e os 24% medidos acima.

Prova aquém do piso reprova, e a prosa assume que o defeito é da sonda: ela cita
o provado contra o declarado e diz para não mexer no host. A causa possível é
uma só, porque a senha do início voltou — o prompt não foi cortado, quem se
dimensionou mal fomos nós.

Timeout na calibragem vira `contextTimedOut` na hora, sem disparar o pedido
grande. É o argumento da issue #59 aplicado a um par de pedidos menor ainda: um
teto que a prova pequena não alcança é um teto que a grande também não alcança.

Provedor que responde sem `usage` **aprova**. A constante velha volta a
dimensionar o prompt, e a linha verde diz que o tamanho não foi provado. A
constante fica em 4,091 e não sobe para 5,353 exatamente porque agora ela é
fallback: errando para menos ela aprova quem provou menos do que declarou, e o
texto da aprovação avisa; errando para mais ela acusa de truncamento quem está
íntegro. Reprovar aí mataria o loop de um Provedor saudável por causa de um
campo que ele não devolve, que é a falha que as issues #56, #59, #60 e #64
consertaram uma de cada vez.

Duas chamadas de rede a mais antes da prova cara. Elas custam mil tokens de
prefill cada e rodam depois da prova de `tool_use`, que já absorveu o
carregamento do modelo na GPU (issue #60). Nenhum botão novo no config: o teto é
o mesmo `probeTimeoutSeconds` das outras pernas.
