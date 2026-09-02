# O Ralph confere o resumo por dentro, e nunca consulta o tracker do alvo

O que o Ralph checa no **Resumo de orientação** ele checa lendo o próprio texto:
o `CLAIM` que traz comando de escrita que não é claim, o `STATUS: ready` que vem
sem `TICKET`. Ele não pergunta ao tracker do repositório alvo se aquele ticket
está mesmo na **Fronteira**, e não vai passar a perguntar.

## Considered Options

A checagem que salta aos olhos é a que falta: comparar o `TICKET` do resumo com
a fronteira de verdade. Ela pegaria o caso medido em 01/09/2026, em que a
Orientação devolveu `STATUS: ready` sobre uma issue fechada no dia anterior, e
pegaria também o ticket de outra feature, de outro rótulo, de outro repositório.

Para fazê-la, o Ralph precisaria saber consultar o tracker, e ele não sabe. O
tracker é descrito em `docs/agents/issue-tracker.md`, em prosa, para o agente
ler. No Terraços aquilo vira `gh issue list --label ready-for-agent`; no
Simulador DJI vira uma linha `Status:` dentro de um markdown em `.scratch/`, sem
tracker remoto nenhum. Não há comando comum a extrair.

A saída aparente é o operador declarar o comando de consulta no
`.ralph/config.json`, e o Ralph rodá-lo no host antes de deixar a iteração
começar. Foi recusada porque cria uma segunda descrição do mesmo tracker, agora
em dois lugares que ninguém obriga a concordar: o documento que o agente lê e o
campo que a ferramenta roda. Quando os dois divergirem, o Ralph vai estar
recusando ticket bom com a certeza de quem tem um comando configurado. É a
**Deriva do prompt** com outro nome, e sem o cabeçalho de procedência que ao
menos torna aquela detectável.

Também foi considerado deixar tudo por conta do prompt, que é onde a regra da
fronteira já mora. A medição de 01/09/2026 fechou essa porta: o
`.ralph/prompt.md` do alvo trazia a proibição, a Orientação compôs
`gh issue edit 19 --add-label "ready-for-agent"` assim mesmo, e a iteração rodou
o comando. Prompt pede; código recusa.

## Consequences

Sobra ao Ralph a classe de erro que se enxerga sem sair do texto, e ela é
pequena de propósito. O `CLAIM` é recusado pela flag, nunca pelo subcomando: no
Terraços o claim legítimo é `gh issue edit <n> --add-assignee @me` e o proibido é
`gh issue edit <n> --add-label ...`, mesmo binário, mesmo verbo.

Quem carrega o resto do julgamento é a Orientação, e é ela quem tem como. Saber
se o trabalho de um ticket já foi feito se decide lendo o repositório e o
diário, coisa que o Ralph não faz e que quem orienta acabou de fazer. Por isso o
dever de recusar ticket cumprido é linha de prompt, com o preço que isso tem:
vale enquanto o Provedor obedecer, e só uma rodada real diz se obedeceu.

O ticket errado que passar por essa peneira chega à iteração, e é lá que ele
morre — a iteração reivindica pelo `CLAIM` do resumo e não trabalha ticket que a
Orientação não deu. O que o Ralph garante do lado de fora é mais estreito, e
mais confiável: nenhum comando de escrita entra no repositório alvo travestido
de claim.

Se um dia a Orientação continuar escolhendo ticket de fora da fronteira mesmo
com o prompt em dia, a consulta declarada volta à mesa com o que falta hoje:
evidência de que a peneira estreita não bastou.
