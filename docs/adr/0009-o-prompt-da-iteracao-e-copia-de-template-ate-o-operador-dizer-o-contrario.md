# O Prompt da iteração é cópia de template até o operador dizer o contrário

O operador não escreve Prompt da iteração — ele instala um dos templates de
`prompts/`. Então fidelidade ao template passa a ser a regra, e divergência
passa a ser **Deriva do prompt**, não customização. A procedência mora numa
linha do topo do próprio template (`<!-- ralph:prompt implement -->`), que a
cópia herda de graça: é ela que diz a qual template re-sincronizar, e é ela que
o operador troca por `custom` quando quer o arquivo só para si.

Isto revisa o veredito da issue #17, que decidiu avisar e não consertar porque
"o operador pode ter editado o prompt de propósito". Essa premissa não vale:
ele não edita.

## Considered Options

O `doctor` tratava os dois casos com teorias incompatíveis. Prompt que delega
para a Orientação: mensagem de "desatualizado em relação ao template instalado"
— teoria da procedência. Prompt que não delega: `applicable: false`, silêncio —
teoria da escolha. O efeito é monotonicamente invertido: **quanto mais velho o
prompt, mais mudo o `doctor` fica**, porque a deriva grande apaga a evidência
de que aquele arquivo um dia delegou.

Medido nos 41 logs de `.ralph/logs/` deste repo: 37 iterações com custo
apurado, US$ 109,75 no total, dos quais US$ 0,51 em haiku. **2 das 41** chegaram
a invocar o subagente `orientation`. O `.ralph/prompt.md` em uso durante quase
toda essa conta é o que hoje está salvo como `prompt.md.pre-adr0004.bak`: zero
menções a `subagent_type`, nenhum bloco `STATUS:`. O `doctor` ficou verde o
tempo inteiro. É o ADR-0004 comprado e não consumido.

Ausência do marcador de delegação **não** discrimina: `prompts/entropy.md` e
`prompts/test-coverage.md` também não delegam, e são legítimos. Nenhuma
heurística sobre esse marcador ia separar modo de entropia de implement
fossilizado.

Rejeitados:

- **Procedência no `config.json`.** Não vale retroativamente, exige migração em
  todo alvo já inicializado, e mente no instante em que o arquivo é editado sem
  o config ser tocado. No arquivo, procedência e prova de fidelidade viram a
  mesma comparação de bytes.
- **Vizinho mais próximo por similaridade**, para adivinhar a origem de um
  prompt sem cabeçalho. É o mecanismo que trocaria um loop de entropia por um
  de implement em silêncio — desfecho pior que a deriva que se quer consertar.
  Sem cabeçalho o `doctor` lista os templates e manda escolher; não adivinha.
- **Apagar o cabeçalho como jeito de reivindicar o arquivo.** Arquivo sem
  cabeçalho é indistinguível de prompt anterior a esta decisão, que é a
  população inteira hoje. Silêncio por ausência é o mesmo erro do
  `applicable: false`, com outra roupa. Reivindicar é afirmação positiva:
  `ralph:prompt custom`.
- **`checkOrientationContract` como segunda linha de defesa no `doctor`.** Ver
  Consequences.

## Consequences

O cabeçalho só é carimbado em `ralph init`, que acontece uma vez por alvo.
Todo repo já inicializado cai na retaguarda "escolha você" até passar por um
`--force` — depois disso se auto-cura e nunca mais precisa. No dia 1 essa é a
maioria da população, não uma borda.

`ralph init --force` hoje reescreve o `config.json` a partir dos `DEFAULTS`
(`src/cli.mjs:106`). Como esta decisão faz o `doctor` prescrever esse comando
com muito mais frequência, ele precisa passar a preservar o config e
re-sincronizar só os arquivos de template. Prescrever a correção que apaga a
configuração do operador é pior que a deriva.

Pela mesma razão, `--force` sem `--prompt` passa a reinstalar o template que o
próprio arquivo declara, não o `implement` padrão: um alvo em loop de entropia
que siga o conselho do `doctor` receberia um prompt de implement — a troca
silenciosa que este ADR rejeita duas seções acima, entrando pela porta da
correção em vez da porta da adivinhação. E prompt marcado `custom` só é
sobrescrito quando o operador nomeia um template.

`checkOrientationContract` sai do `doctor` e fica só nos testes. Com fidelidade
como regra, prompt que bate com o template não pode ter contrato divergente — o
teste que compara os dois prompts distribuídos já garante isso dentro do Ralph
—, e prompt que não bate já recebeu o aviso de deriva. Dois avisos para uma
causa só é ruído, e o caminho no `doctor` vira código que ninguém percorre.

O cabeçalho viaja para dentro do contexto da iteração, sem remoção na
renderização. Removê-lo criaria divergência entre o arquivo em disco e o que o
agente lê, que é exatamente o que esta decisão existe para eliminar. É a
exceção da regra de `prompts/`: a linha não é prosa, é o interruptor.

Em `prompts/implement.md` o cabeçalho fica na segunda linha, não na primeira:
a primeira é a invocação `/mattpocock-skills:implement`, e o `claude -p` só a
reconhece como comando quando o prompt começa com ela. Por isso a procedência é
lida como a primeira linha do arquivo que seja exatamente o comentário, e não
como a linha 1 — o que também impede que prosa mencionando o marcador de
passagem vire procedência.

A comparação normaliza `\r\n` para `\n` dos dois lados. `.ralph/prompt.md` é
commitado no alvo e `.gitattributes` costuma marcar `*.md text` sem `eol=lf`;
sem normalizar, um clone Windows acusa deriva onde só houve checkout.

O conjunto de templates de iteração é declarado, não derivado de `readdir` em
`prompts/`: `orientation.md` mora lá e é prompt de subagente, não de iteração.
Hoje `ralph init --prompt orientation` o instala como Prompt da iteração sem uma
palavra.
