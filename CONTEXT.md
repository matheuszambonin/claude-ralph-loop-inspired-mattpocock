# Ralph

Glossário do Ralph. Só termos cujo sentido é próprio desta ferramenta —
conceito geral de programação não entra aqui, mesmo que o código use muito.

## Language

**Repositório alvo**:
O repositório em que o loop trabalha, sempre outro que não o do Ralph. Existe
antes do Ralph e é curado à mão para as sessões que rodam no host; o Ralph se
adapta a ele, nunca o contrário.
_Avoid_: projeto, repo do usuário, workspace

**Sandbox**:
O container descartável onde uma iteração roda. É a unidade de invalidação do
que o Ralph configura para si mesmo: essa configuração vive dentro dele e morre
com ele.
_Avoid_: container, ambiente, box

**Configuração executável do alvo**:
O que o repositório alvo carrega e que o git ou o Claude Code rodam sozinhos,
sem ninguém mandar — hooks e servidores MCP. O sandbox nunca a executa; lê-la
como dado é outra coisa, e é permitido.
_Avoid_: herança, config do repo, hooks

**Índice de conhecimento**:
Estrutura pré-computada sobre o repositório alvo que responde "onde está X" e
"o que X toca" sem ler os arquivos. Existe antes do Ralph e independe dele.
_Avoid_: grafo, RAG, índice de código

**Backend**:
Uma implementação concreta de índice de conhecimento, com seu próprio jeito de
ser consultada. Um repositório pode ter vários ao mesmo tempo.
_Avoid_: provider, engine, motor

**Iteração**:
Uma passagem completa do loop sobre o repositório alvo: começa sem memória
nenhuma, entrega no máximo um ticket e termina esquecendo tudo. É ao mesmo
tempo a unidade de trabalho e a unidade de esquecimento — o que precisa
sobreviver a ela precisa estar em disco antes de ela acabar.
_Avoid_: rodada, execução, run, volta do loop, sessão

**Prompt da iteração**:
O texto que dirige uma Iteração inteira, instalado uma vez no repositório alvo
a partir de um template do Ralph. É a única coisa que o Ralph copia para o alvo
e depois esquece — nunca re-sincroniza sozinho. O operador não o escreve: um
prompt que não é cópia fiel de um template instalado está em **Deriva do
prompt**, não customizado.
_Avoid_: prompt.md, prompt do loop, promptFile

**Deriva do prompt**:
O estado em que o **Prompt da iteração** deixou de ser cópia fiel do template
que o originou, porque o Ralph que o lê avançou e ele ficou parado. Não é
escolha de ninguém — como o operador não escreve esses textos, toda divergência
é atraso. É cara porque é silenciosa: o prompt continua rodando e produzindo
iterações, só que sem as fases que o Ralph atual espera delas.
_Avoid_: prompt customizado, prompt velho, drift

**Orientação**:
A fase inicial de uma iteração, em que o agente descobre o que precisa saber
antes de mexer em código. É onde o índice de conhecimento é consultado, e é a
fase que o loop existe para manter barata. O que ela entrega é um resumo — o
ticket escolhido e o que ele exige —, não o material lido para chegar lá; por
isso ela não precisa acontecer no mesmo contexto que a consome. Acontece uma
vez por iteração: uma segunda orientação não é a fase inicial de nada.
_Avoid_: exploração, varredura, reconhecimento, scout

**Resumo de orientação**:
O que sobrevive à Orientação e entra no contexto da iteração. Tudo o que foi
lido para produzi-lo morre junto com quem o produziu.
_Avoid_: briefing, contexto, relatório

**Provedor**:
De onde vem a inferência de uma iteração. Não se confunde com **Backend**, que
é implementação de índice de conhecimento: um responde "quem pensa", o outro
"onde está X". Vale para a iteração inteira, não por fase — a Orientação roda
como subagente do mesmo processo, e a base URL é do processo. O que cada fase
escolhe dentro do Provedor é o modelo.
_Avoid_: backend, motor, engine, modelo

**Night mode**:
O modo em que as fases da iteração rodam num Provedor local, escolhido por
flag explícita e nunca pelo relógio. Existe para gastar tempo de máquina
ociosa em vez de token pago — não para sigilo, e não para velocidade.
Ortogonal ao AFK: uma iteração pode ser assistida e ainda assim noturna.
_Avoid_: modo offline, modo local, modo barato
