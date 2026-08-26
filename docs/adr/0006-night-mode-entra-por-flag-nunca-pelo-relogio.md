# O night mode entra por flag explícita, nunca pelo relógio

`--night` em `ralph once` e `ralph afk` é o único acionamento do Provedor local.
A mesma linha de comando produz o mesmo Provedor às três da tarde e às três da
manhã. O Ralph não lê o relógio para decidir quem pensa.

`ralph doctor --night` (issue #40) segue o mesmo princípio aplicado à
inspeção: o gate das três provas do Provedor é a flag, não a presença de
`nightProvider` no config — desde que o padrão passou a morar em `DEFAULTS`,
"configurou" e "quer as provas agora" deixaram de ser a mesma coisa.

## Considered Options

A troca automática por horário é o desenho óbvio — o modo se chama night mode, a
máquina fica ociosa à noite, e o operador não teria que lembrar de nada. Foi
rejeitada pelo `PROGRESS.md`.

O diário de progresso é escrito por iterações que não se lembram umas das
outras, e o Provedor é a variável que mais muda o que sai de uma. Com o relógio
decidindo, duas entradas consecutivas do mesmo arquivo deixam de ser comparáveis
sem que alguém reconstitua a que horas cada uma rodou; um `ralph afk -n 40` que
atravessa a virada troca de modelo no meio da noite e nada no registro diz isso.
E não há resposta boa para a iteração que começa às 21h58 e termina às 22h07:
qualquer lado que se escolha é arbitrário, e arbitrário aqui significa um commit
cuja origem ninguém consegue explicar depois.

Um `"night": true` no `config.json` seria igualmente determinístico e também foi
rejeitado, por outra razão: o config descreve **como é** o Provedor local
(`nightProvider` — endereço, tags, `keep_alive`, contexto mínimo), e a flag
decide **se** ele é usado nesta execução. Misturar as duas coisas num campo só
tira da linha de comando a decisão que muda a fatura.

## Consequences

`--night --model <tag>` é válido, e a tag vence como modelo local — a mesma
precedência que `--model` já tem hoje. As duas flags entram pela mesma costura
(`withOverrides`), que `once` e `afk` compartilham.

O determinismo só vale se ficar registrado: o cabeçalho do loop e o da iteração
dizem que o Provedor é local e qual tag está atendendo. Sem isso, o
`PROGRESS.md` lido meses depois volta a exigir a arqueologia que este ADR existe
para evitar.

Night mode é ortogonal ao AFK. `ralph once --night` existe justamente para
aprender com uma iteração local antes de soltar o loop, e uma iteração assistida
pode ser noturna.

O custo é o operador ter que digitar a flag. Aceito: quem quiser agendar a noite
tem `cron`, `at` e o Agendador de Tarefas do lado de fora, e nenhum deles obriga
o Ralph a saber que horas são.
