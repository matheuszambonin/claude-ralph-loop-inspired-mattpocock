# O MCP do índice entra por `--mcp-config` efêmero, sem tocar no repositório alvo

O Ralph monta um `--mcp-config` na hora da iteração, com os caminhos e o
endereço do Ollama corrigidos para dentro do container, e passa
`--strict-mcp-config` para que o `.mcp.json` do repositório alvo seja ignorado.

## Considered Options

Reescrever o `.mcp.json` do alvo foi rejeitado: ele é curado à mão, versionado,
e serve às sessões de Claude Code que rodam no **host**, onde os caminhos e o
`localhost` estão certos. Corrigi-lo para o container quebraria o uso normal.

Deixar o `.mcp.json` do alvo ser usado como está é o comportamento de hoje, e
ele falha: medido no sandbox do Terraços, o evento `init` da sessão traz
`mcp_servers: [{"name":"code-review-graph","status":"failed"}]` e zero tools de
MCP. O binário não existe no container e `localhost:11434` lá dentro é o próprio
container. A sessão não avisa — só cai no grep, que é o custo que este trabalho
existe para evitar.

## Consequences

O `.mcp.json` do alvo deixar de ser lido pela sessão e o `post-commit` dele
deixar de rodar dentro do container são o mesmo movimento, e viraram decisão
própria: ver ADR-0005 — inclusive para o escopo da neutralização, que é o que
impede a correção óbvia de vazar de volta para o host. Aqui fica só o que é do
índice: o `--mcp-config` efêmero existe porque o servidor precisa de caminho de
container e de um endereço que alcance o host.
