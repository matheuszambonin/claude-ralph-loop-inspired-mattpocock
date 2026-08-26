# O sandbox não executa a configuração executável do alvo

O repositório alvo carrega configuração que o git e o Claude Code rodam sozinhos
— `.git/hooks`, `.mcp.json`. Dentro do sandbox ela está errada (caminhos de
host, `localhost` que resolve pro próprio container) e cara: o `post-commit`
regrava o índice de conhecimento do host com caminhos de container, e a iteração
seguinte varre arquivo porque o índice mente. O sandbox neutraliza essa
configuração — `core.hooksPath` para um diretório vazio, `--strict-mcp-config`
sempre — e neutraliza **no HOME do container**, nunca no repositório alvo.

## Considered Options

`git -C "$alvo" config core.hooksPath …`, a forma óbvia, foi rejeitada: o
workspace é bind mount **rw**, então a neutralização voltaria pelo mount e
desligaria os hooks do usuário fora do sandbox. É a fronteira do ADR-0001 vista
de dentro — escrever no `.git/config` do alvo é escrever no alvo. O escopo
global vence o `.git/hooks` do repositório sem apagar nada e morre com o
container. Medido em git 2.53: com `core.hooksPath` global apontado para um
diretório vazio, o `post-commit` local do repositório não roda.

`--strict-mcp-config` é incondicional, inclusive em repositório sem índice
detectado: o `.mcp.json` do alvo é curado para as sessões que rodam no host e
não fica menos errado por não haver índice.

## Consequences

**Executar não é ler.** O Ralph lê o repositório alvo o tempo todo — é assim que
o índice é detectado — e continua podendo ler o `.mcp.json` como dado, para
reaproveitar o env de embeddings que já está declarado lá em vez de pedir que o
operador redigite os mesmos valores em `.ralph/config.json`. O que a fronteira
proíbe é o git e o Claude Code **rodarem** aquilo dentro do container. Quem ler
`--strict-mcp-config` e depois vir o arquivo sendo lido não está vendo uma
contradição: são verbos diferentes, e é esta linha que responde.

Ao ler, `CRG_TOOLS` é descartado. Ele está declarado no `.mcp.json` do alvo com
a lista completa de tools, e importá-lo em bloco desfaria por variável de
ambiente o filtro que o ADR-0003 acabou de aplicar — devolvendo à sessão a tool
que a sonda tinha removido.
