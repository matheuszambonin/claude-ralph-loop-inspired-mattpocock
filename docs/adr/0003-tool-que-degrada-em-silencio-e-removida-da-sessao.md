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

A sonda mede o **provedor de embeddings declarado**, não o Ollama: Ollama era o
caso medido, não a decisão. O endereço sai de `CRG_OPENAI_BASE_URL` — do
`crgEmbeddingEnv` ou do `.mcp.json` do alvo (ADR-0005) — e a prova é um pedido
de embedding de verdade, não um teste de porta. Porta aberta não prova nada
contra provedor remoto: `api.openai.com:443` abre com chave errada, cota
estourada ou modelo inexistente, e a busca devolve `search_mode: "none"` — a
mentira que este ADR existe para matar. Um Ollama no ar mas sem o modelo
baixado falha igual, e o teste de porta também não vê.

Sem provedor declarado em lugar nenhum não há o que provar, e a tool sai: com
env vazio o servidor cai num default do upstream que o Ralph não verificou, e
chamar isso de "funciona" é a mesma fé que este ADR recusa quando a sonda não
responde.
