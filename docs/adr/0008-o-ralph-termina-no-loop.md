# O Ralph termina no loop: o gate pós-loop não é escopo dele

O Ralph entrega iterações e para. O code review sobre o agregado de uma noite —
o que decide se aquilo vira PR — continua sendo feito à mão pelo operador, com a
IA que ele escolher, fora desta ferramenta. Não haverá `ralph review`.

## Considered Options

Um `ralph review` parece o passo seguinte óbvio, e o night mode reforça a
impressão: 40 iterações de um modelo local produzem, de manhã, um agregado que
alguém tem de olhar. Foi rejeitado porque viola ao mesmo tempo as três coisas
que definem uma Iteração — ele precisa de memória entre iterações, porque o que
se revisa é o conjunto e não o commit; não escolhe ticket; e não cabe num
contexto que morre. Uma fase que precisa lembrar não é uma iteração do loop
Ralph. Seria outra ferramenta morando no mesmo binário, com o `-n` e o cooldown
do loop sem significado nenhum para ela.

Rodá-lo como iteração final do próprio loop, usando o `PROGRESS.md` como a
memória que falta, funciona à primeira vista e falha exatamente onde importa: o
`PROGRESS.md` é o que as iterações escolheram registrar, não o diff. Revisar o
registro em vez do código é aceitar a versão do autor sobre o próprio trabalho —
e numa noite o autor foi o modelo mais fraco da casa.

## Consequences

A barra de qualidade da entrega é posta de fora, e é isso que torna o night mode
seguro: `--night` troca de onde vem a inferência das iterações sem mexer em quem
aprova o resultado. Um modelo local mais fraco encarece a revisão da manhã, não
o risco do que é mergeado.

Tudo que o Ralph relata — cabeçalho por iteração, resumo do loop, custo — existe
para alimentar esse gate humano, não para substituí-lo. É por isso que uma noite
local imprime "sem custo — Provedor local" em vez de "custo não reportado": as
duas frases significam coisas opostas para quem lê o resumo de manhã, e só uma
delas pede investigação.

Isso põe em `-n` um teto prático que nenhuma linha de código impõe: o limite
útil de iterações por noite é o quanto de diff uma pessoa revisa numa manhã. O
Ralph não vai avisar disso, porque não é ele quem sabe.

É também a outra metade do "falha alta, sem fallback": não há revisor acordado
durante a noite, então a única proteção contra 40 iterações inúteis é recusar
antes da primeira.
