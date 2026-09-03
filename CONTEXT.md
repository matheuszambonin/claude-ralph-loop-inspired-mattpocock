# Ralph

Glossário do Ralph. Só termos cujo sentido é próprio desta ferramenta —
conceito geral de programação não entra aqui, mesmo que o código use muito.

## Language

**Repositório alvo**:
O repositório em que o loop trabalha. Existe antes do Ralph e é curado à mão
para as sessões que rodam no host; o Ralph se adapta a ele, nunca o contrário.
Pode ser o próprio repositório do Ralph, e foi assim que rodaram as iterações
cobradas que o ADR-0004 mede.
_Avoid_: projeto, repo do usuário, workspace

**Sandbox**:
O container descartável onde uma iteração roda. É a unidade de invalidação do
que o Ralph configura para si mesmo: essa configuração vive dentro dele e morre
com ele.
_Avoid_: container, ambiente, box

**Workspace do sandbox**:
Cada diretório do host que o `docker sandbox create` monta dentro do
container — o repositório alvo, os plugins do host, a raiz de instalação do
Ralph, os mounts extras. Não é o **repositório alvo**: este é só um dos
workspaces montados. Onde a mensagem ou o teste falam do diretório montado em
si, não do que ele contém, o termo é este.
_Avoid_: volume (a unidade de disco do host é **volume do host**), bind mount,
ponto de montagem

**Volume do host**:
A unidade de disco do Windows onde um ou mais **workspaces do sandbox** vivem,
identificada pela letra (`C:`, `G:`) e pelo sistema de arquivos que reporta.
Não é o workspace: vários workspaces cabem no mesmo volume, e é o volume — não
o diretório — que decide se o compartilhamento de arquivos do `docker sandbox`
consegue ser construído. Só tem sentido no Windows, a única plataforma onde há
letra de volume.
_Avoid_: unidade, drive, partição

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

**Provedor de embeddings**:
De onde vem o vetor da consulta na busca semântica de um **Índice de
conhecimento**. Não é o **Backend**, que é o índice consultado, nem o
**Provedor**, que é quem pensa a iteração; pode ser o mesmo Ollama que este sem
ser o mesmo papel. Existe quando endereço e modelo estão resolvidos, e quem
declara os dois é primeiro o repositório alvo. A configuração do Ralph
sobrescreve, não origina. Sem modelo declarado não existe, e a busca semântica
sai da sessão.
_Avoid_: Ollama, backend de embeddings, provedor (sozinho, é o outro)

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
"onde está X". Nem com o **Provedor de embeddings**, que serve à busca desse
outro. Vale para a iteração inteira, não por fase — a Orientação roda como
subagente do mesmo processo, e a base URL é do processo. O que cada fase
escolhe dentro do Provedor é o modelo.
_Avoid_: backend, motor, engine, modelo

**Night mode**:
O modo em que as fases da iteração rodam num Provedor local, escolhido por
flag explícita e nunca pelo relógio. Existe para gastar tempo de máquina
ociosa em vez de token pago — não para sigilo, e não para velocidade.
Ortogonal ao AFK: uma iteração pode ser assistida e ainda assim noturna.
_Avoid_: modo offline, modo local, modo barato

**Teto da iteração**:
Quanto tempo uma iteração pode durar antes de o Ralph matar o `claude` e parar
o loop. É paciência declarada pelo operador, não medida de velocidade: máquina
lenta com modelo grande espera muito e está certa. O que o teto recusa é a
espera infinita — o laço fechado que o **AFK** existe para dispensar e que,
sem teto, queima a noite na iteração 1. Ele não é o corte por laço: aquele lê
repetição no stream e mata em segundos, na Orientação ou no processo
principal, e deixa o loop seguir.
_Avoid_: timeout, deadline, limite de tempo

**Orçamento de saída**:
Quantos tokens o Provedor pode escrever numa resposta. É teto do pedido, não
capacidade do Provedor, e não se confunde com o contexto, que é o que ele
consegue ler. A distinção só passou a doer quando o modelo que raciocina antes
de responder virou norma: o raciocínio gasta orçamento de saída e não deixa
texto, e uma sonda que confunde os dois acusa de truncar o prompt quem leu o
prompt inteiro.
_Avoid_: max_tokens, limite de tokens, teto de resposta

**Corte por orientação**:
Matar a iteração assim que o **Resumo de orientação** volta dizendo que não há
ticket para trabalhar. Irmão do **Corte por laço** e diferente dele no que lê:
ali o sinal é repetição de chamada, aqui é o veredicto que já chega pronto no
primeiro passo da iteração. Vale por si, sem a promise, porque quem leria o
resumo e decidiria obedecê-lo é o mesmo modelo que acabou de ler a receita do
ticket junto dele.
_Avoid_: abort, corte por status, parada antecipada

**Corte por laço**:
Matar a iteração que repete a mesma chamada de ferramenta sem sair do lugar,
lendo o stream em vez do relógio. Distingue-se do **Teto da iteração** por
onde acerta e a que preço: o teto cobra uma hora de espera e para o loop; o
corte sai em segundos e deixa o loop escolher outro ticket. Conta por fase,
com teto próprio em cada uma, porque a **Orientação** que lê e relata não
deveria repetir nada, enquanto o processo principal roda a mesma suíte de novo
de forma legítima.
_Avoid_: detecção de loop, anti-loop, watchdog

**Fronteira**:
Os tickets do repositório alvo que uma iteração pode pegar agora: rótulo de
pronto para agente, bloqueador nenhum em aberto, ninguém trabalhando neles.
Quem a define é o tracker do alvo, e o Ralph só a lê. Estar na fronteira não é
o mesmo que ter trabalho: uma spec cujos filhos estão todos entregues continua
lá até alguém tirar o rótulo, e foi assim que duas Orientações mandaram
implementar o que já existia. A distinção é da **Orientação**, que lê o
repositório e o diário e sabe dizer; nunca do Ralph, que não consulta tracker
nenhum (ADR-0010).
_Avoid_: frontier, fila, backlog, próximo ticket

**Corte por resumo inválido**:
Matar a iteração porque o **Resumo de orientação** veio errado — um `CLAIM` que
é comando de escrita em vez de reivindicação, um `ready` sem ticket ou sem
`CONTEXT`. É o avesso do **Corte por orientação**: ali o Ralph obedece ao
resumo, aqui desconfia dele. Lê só o texto do resumo, e é por isso que alcança
tão pouco: tudo que exigiria perguntar ao tracker fica fora, por escolha
(ADR-0010). Como o **Corte por laço**, mata a iteração e deixa o loop seguir —
o defeito é da resposta que aquele contexto produziu, e o próximo nasce limpo.
_Avoid_: validação do contrato, corte por claim, sanity check

**Campo à toa**:
Campo do **Resumo de orientação** preenchido num resumo que para o loop — um
ticket nomeado ou um `CONTEXT` escrito sob `complete` ou `blocked`. Vira aviso,
nunca corte, porque o **Corte por orientação** já matou a iteração pelo
`STATUS`: o estrago não é trabalho errado, é o operador lendo de manhã uma
afirmação que ninguém conferiu. O `WHY` não conta como campo à toa, porque sob
esses dois status é ele que o operador lê.
_Avoid_: stray, campo órfão, resumo contraditório

**Turno**:
A unidade que o Provedor conta e cobra dentro de uma **Iteração**, e o número
que o Ralph imprime quando ela acaba. Não é o **Passo do modelo**: um turno
abrange vários, e nos cinco logs de 24/08 a razão foi de 2,8 para 1. A confusão
entre os dois já custou caro. A tabela de repartição do ADR-0004 dividiu tokens
por passos e chamou o resultado de tokens por turno.
_Avoid_: rodada, turno do agente, num_turns (é o campo que o carrega, não o
termo)

**Passo do modelo**:
Cada vez que o modelo fala dentro de uma **Iteração**, seja texto, raciocínio
ou chamada de ferramenta. Existe como termo porque é a contagem que acompanha o
custo: o custo por passo varia bem menos entre iterações do que o custo por
iteração, e é nele que uma economia aparece antes de aparecer na fatura. Não
sai em relatório nenhum do Ralph, só nos logs.
_Avoid_: turno, mensagem, evento
