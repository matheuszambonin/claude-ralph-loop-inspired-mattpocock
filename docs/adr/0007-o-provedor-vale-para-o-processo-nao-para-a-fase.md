# O Provedor vale para o processo, não para a fase

Uma iteração tem um Provedor só. A Orientação e o trabalho em código que ela
orienta pensam obrigatoriamente no mesmo lugar — os dois na API paga, ou os dois
no Provedor local. O que continua sendo escolhido por fase é o **modelo**.

## Considered Options

Provedor por fase era o desenho inicial, e a entrada **Provedor** do
`CONTEXT.md` chegou a prometê-lo: Orientação no modelo local, que só lê e
relata, e o trabalho em código no Claude pago. A ideia é boa e a arquitetura não
a permite.

A Orientação roda como subagente do mesmo `claude -p` da iteração (ADR-0004), e
o desvio para o Provedor local é `ANTHROPIC_BASE_URL` — variável de
**processo**. Um processo tem uma base URL só. Não existe "Orientação local com
iteração paga" sem transformar a Orientação em processo próprio, o que refaz o
ADR-0004 e o contrato do Resumo de orientação: é outra feature, não um parâmetro
desta.

A saída que preservaria as duas coisas seria um proxy no meio, roteando por
modelo para o Ollama ou para a Anthropic. Rejeitada pelo que ela custa contra o
que ela substitui: o night mode existe para **não** gastar, e um tradutor de
protocolo local seria a peça mais cara de manter do desenho inteiro — enquanto o
desvio sem ele são três variáveis de ambiente (endereço, token e Orçamento de
saída — a terceira entrou na issue #69), porque o Ollama fala a Messages API
nativamente em `/v1/messages` desde a 0.14.0. Sem proxy, sem shim.

## Consequences

Um campo de Provedor, dois de modelo: `nightProvider.model` e
`nightProvider.orientationModel` (`null` = herda o da iteração). A economia por
fase que o ADR-0004 foi buscar continua disponível dentro do Provedor local — um
modelo menor na fase que só lê e relata —, só que agora ela é uma troca de tag
do Ollama, não uma troca de quem pensa.

A autenticação passa a ser pergunta sobre o Provedor, não sobre a fase. Como
nenhuma fase é paga durante a noite, `prepare()` só chama `checkAuth()` quando o
Provedor resolvido é o `anthropic`, e `ralph afk --night` roda num sandbox que
nunca viu `/login`.

`--night` é tudo-ou-nada: não há noite parcial. Modelo local que reprova nas
provas do `doctor` se resolve trocando a tag ou rodando sem `--night` — nunca
misturando as duas origens de inferência na mesma iteração.

Este é o único ADR do night mode que cai sozinho: no dia em que a Orientação
virar processo próprio, a restrição some junto com a razão dela.
