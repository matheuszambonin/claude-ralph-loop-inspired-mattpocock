# Ralph

CLI em Node puro que roda o loop Ralph Wiggum sobre um repositório alvo: cada
iteração é um processo `claude -p` novo, dentro de um sandbox Docker, e morre
levando o contexto junto. Ver `README.md` para a visão geral.

Não há build e não há dependências — `src/*.mjs` roda direto no Node 18+.

## Convenções

- Comentários e texto de interface em português; identificadores, nomes de
  arquivo e os prompts de `prompts/` em inglês.
- Comentário registra o **porquê**, tipicamente o bug que motivou a linha
  (veja `core.autocrlf` em `src/runner.mjs`). Não descreva o que o código já diz.
- Zero dependências: só a biblioteca padrão do Node. Isso é uma restrição de
  projeto, não uma coincidência — a ferramenta precisa rodar sem `npm install`.
- Erros de usuário dizem o comando que conserta, não só o que falhou.

## Verificação

`tests/` roda com `node:test`, biblioteca padrão — sem dependência nova. O
mínimo antes de commitar:

```bash
node --check src/*.mjs
bash -n sandbox/bootstrap.sh templates/setup.sh bin/ralph
node --test tests/*.test.mjs
```

Isso pega erro de sintaxe e o que `tests/` cobre — as costuras puras:
`knowledge-index`, `credentials`, `orientation`, a montagem do prompt em
`runner` e a agregação de custo em `stream`. Mudança em `sandbox/bootstrap.sh` ou em
`src/sandbox.mjs` só está provada quando `ralph bootstrap --force` roda limpo
num sandbox de verdade e `ralph doctor` fecha verde num repo alvo — o
comportamento que importa está do lado de dentro do container.

## Nível de qualidade

Ferramenta pessoal em uso real. Prefira a correção óbvia à abstração
antecipada; um caminho de código que ninguém percorre é dívida, não preparo.

## Agent skills

### Issue tracker

Issues ficam no GitHub Issues deste repo, via `gh`. Ver `docs/agents/issue-tracker.md`.

### Triage labels

Vocabulário canônico de cinco labels, sem renomes. Ver `docs/agents/triage-labels.md`.

### Domain docs

Single-context: um `CONTEXT.md` e `docs/adr/` na raiz. Ver `docs/agents/domain.md`.
