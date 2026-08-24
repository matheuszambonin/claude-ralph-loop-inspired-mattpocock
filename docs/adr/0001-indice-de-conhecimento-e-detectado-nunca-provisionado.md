# Índice de conhecimento é detectado, nunca provisionado

O Ralph reconhece um índice de conhecimento que já existe no repositório alvo e
adapta a iteração a ele. Não constrói índice, não instala ferramenta de índice
no host, não escreve git hook, não mexe no `CLAUDE.md` do alvo.

## Considered Options

Absorver o `setup-grafos.sh` do Terraços como um `ralph index build` foi
considerado e rejeitado. Provisionar exige `pip install` no host, `python-igraph`,
`ollama pull`, escrita de dois git hooks, um bloco gerado dentro do `CLAUDE.md`
do alvo e um proxy HTTP local — todas operações de **host**, cada uma com seu
próprio modo de falha silenciosa. Hoje o Ralph não escreve nada no repositório
alvo fora de `.ralph/`, e essa fronteira é o que torna seguro apontá-lo para um
repositório de verdade.

## Consequences

Repositório sem índice roda exatamente como antes: a detecção devolve vazio, o
placeholder do prompt vira string vazia e o prompt fica byte a byte igual ao de
hoje. É essa propriedade — e não um teste — que garante não termos quebrado o
caminho que já funcionava.
