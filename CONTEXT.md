# Ralph

Glossário do Ralph. Só termos cujo sentido é próprio desta ferramenta —
conceito geral de programação não entra aqui, mesmo que o código use muito.

## Language

**Índice de conhecimento**:
Estrutura pré-computada sobre o repositório alvo que responde "onde está X" e
"o que X toca" sem ler os arquivos. Existe antes do Ralph e independe dele.
_Avoid_: grafo, RAG, índice de código

**Backend**:
Uma implementação concreta de índice de conhecimento, com seu próprio jeito de
ser consultada. Um repositório pode ter vários ao mesmo tempo.
_Avoid_: provider, engine, motor

**Orientação**:
A fase inicial de uma iteração, em que o agente descobre o que precisa saber
antes de mexer em código. É onde o índice de conhecimento é consultado, e é a
fase que o loop existe para manter barata. O que ela entrega é um resumo — o
ticket escolhido e o que ele exige —, não o material lido para chegar lá; por
isso ela não precisa acontecer no mesmo contexto que a consome.
_Avoid_: exploração, varredura, reconhecimento, scout

**Resumo de orientação**:
O que sobrevive à Orientação e entra no contexto da iteração. Tudo o que foi
lido para produzi-lo morre junto com quem o produziu.
_Avoid_: briefing, contexto, relatório
