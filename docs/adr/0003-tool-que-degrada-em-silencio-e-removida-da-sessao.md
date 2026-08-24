# Tool que degrada em silêncio é removida da sessão, não mantida

Quando uma tool do índice depende de um serviço que o Ralph sondou e não
respondeu, ela sai da lista exposta ao agente em vez de ser oferecida e falhar.

## Considered Options

O caso concreto é a `semantic_search_nodes` do `code-review-graph`, que precisa
embeddar a query no Ollama. Medido no sandbox: o Ollama do host está no ar e
saudável, mas escuta em `127.0.0.1:11434`, então o container não o alcança —
`host.docker.internal` resolve, a porta não abre. Sem o Ollama a busca não dá
erro: devolve `search_mode: "none"` e zero resultado. O agente lê isso como
"não existe no repositório" e vai varrer arquivo. Uma tool que mente é pior do
que uma tool ausente, porque a ausência o agente contorna e a mentira ele
acredita.

Exigir `OLLAMA_HOST=0.0.0.0` foi rejeitado como pré-requisito: mudar a interface
de escuta do Ollama é decisão de rede do dono da máquina, não do Ralph. As
outras nove tools do filtro são consulta pura sobre SQLite e funcionam sem
Ollama nenhum.

## Consequences

A lista `CRG_TOOLS` deixa de ser constante e passa a ser derivada de uma sonda
por sandbox. O `doctor` reporta a degradação em amarelo com a linha exata que a
desfaz.
