# O Ralph opera só dentro do sandbox, e workspace que não monta é parada

Toda iteração roda dentro de um `docker sandbox`. Quando o `docker sandbox
create` não consegue construir o compartilhamento de arquivos de um workspace do
sandbox, o Ralph reporta e para. Não há modo sem sandbox, modo host, cópia
automática do repositório alvo nem sincronização, e a ausência é decisão, não
pendência.

## Considered Options

A alternativa aparece sozinha, porque a falha é dura. Repositório alvo que vive
num volume sincronizado — Google Drive File Stream, OneDrive, volume de rede
mapeado — derruba a criação do sandbox antes do boot da VM, e quem topa com isso
chega rápido à mesma ideia: e se o Ralph tivesse uma flag para rodar direto no
host?

A limitação está descrita aqui para ninguém refazer a investigação. O
`docker sandbox` tem uma única primitiva de compartilhamento de arquivos,
virtiofs, com um device por workspace do sandbox construído junto com a VM,
antes do boot. O que já foi verificado e não funciona:

- `docker sandbox create claude` aceita, por workspace, só o sufixo `:ro`. Não
  há flag de tipo de mount, de cópia nem de pular workspace.
- Nenhuma das variáveis de ambiente que o sandbox lê (`DOCKER_SANDBOXES_API`,
  `DEBUG`, `TEMPLATE_IMAGE`, `VM_BASE_DIR`, `CACHE`) afeta o mount, e a
  `DOCKER_SANDBOXES_ENABLE_VIRTIOFS_CACHE=0` que aparece na documentação não
  existe nos binários da v0.12.0.
- A escolha de implementação de compartilhamento
  (`useVirtualizationFrameworkVirtioFS`, `useGrpcfuse`) é Mac-only, sem
  equivalente no Windows.
- O `metadata.json` do sandbox registra `workspace` e
  `additional_workspaces[{dir, read_only}]`, sem campo de tipo de mount.
- A documentação do `docker sandbox` desaconselha "network drives, SMB/NFS
  shares, or cloud-synced folders" como workspace, mas por performance. A falha
  dura não está documentada, e não há issue pública com essa assinatura.

Reproduzido em 02/09/2026, no Windows 11 com openvmm sobre WHP, `docker sandbox`
v0.12.0 sobre o Docker Engine 29.4.0, montando como workspace do sandbox uma
pasta num volume do Google Drive File Stream (`I:`, que reporta FAT32 e disco
fixo):

```
create runtime: create/start VM: POST VM create failed: status 500:
… panic detected in openvmm: … could not construct device: failed to resolve
resource of type pci_device_handle:virtio: failed to resolve virtio device:
failed to resolve resource of type virtio:virtiofs: EINVAL (22)
```

Esse panic não é o mesmo texto registrado na issue #24 — ganhou a cadeia do
`pci_device_handle` no meio — e `virtio:virtiofs` + `EINVAL` continuam onde
estavam. É a razão pela qual `describeSandboxCreateFailure` casa só esses dois
fragmentos, e nunca a frase inteira.

O modo host foi **considerado e recusado**. O que ele economiza é um clone; o
que ele custa é a premissa inteira. A iteração roda `claude` com
`--permission-mode bypassPermissions`, sem revisor acordado, e o repositório
alvo que motiva o modo host é justamente o que vive num compartilhamento
corporativo que outras pessoas leem e escrevem. Trocar o container por "roda
aqui mesmo" não degrada a ferramenta, faz dela outra coisa. O isolamento é a
razão pela qual apontar o Ralph para um repositório de verdade e ir dormir é
aceitável, e não um recurso que se possa desligar quando incomoda.

Cópia automática e sincronização foram recusadas pelo mesmo motivo em outra
escala. O Ralph passaria a ser dono de uma sincronização de mão dupla sobre uma
árvore em que ele commita, com resolução de conflito contra um cliente de nuvem
que também escreve ali. Isso é outro produto, e um que falha em silêncio. O
sintoma de sincronização errada não é erro, é trabalho perdido. A fronteira do
ADR-0001 — o Ralph não escreve no repositório alvo fora de `.ralph/` — vale aqui
com a mesma força.

## Consequences

Sobra a saída em disco local. O repositório alvo do Ralph vira um clone em `C:`,
e o working tree que vive no volume sincronizado continua sendo o do usuário.
Manter os dois alinhados é configuração de ambiente do repositório alvo —
remote, branch, o ritmo com que um puxa do outro — e nada disso é código do
Ralph. Ele não vai propor o clone, criá-lo nem conferi-lo.

O que o Ralph faz é a parada explicada, em dois pontos.
`describeSandboxCreateFailure` traduz o erro quando o `create` falha e o stderr
do docker traz a assinatura; sem ela sai o código de saída de sempre. Antes
disso, o `ralph doctor` avisa por `describeWorkspacesOutsideLocalDisk` quando um
volume do host que abriga workspace reporta sistema de arquivos que não é o de
disco local — só no Windows, a única plataforma onde a sonda colhe alguma coisa,
e só quando o volume reporta qual é. Ambos vivem em `src/sandbox.mjs` e são a
materialização desta decisão. Onde caberia um fallback, o que existe é uma
explicação.

Se um dia o `docker sandbox` ganhar uma segunda primitiva de compartilhamento, o
que muda é o diagnóstico, não a decisão. Reencontrar o `EINVAL` não reabre nada,
porque é o caso que este ADR cobre. O que reabriria a conversa não é o modo
host, e sim isolamento de força equivalente disponível fora do Docker.
