import { translateLoopback } from "./paths.mjs";
import { execCapture } from "./sandbox.mjs";

/**
 * Pura: config e a flag `--night` entram, o Provedor resolvido sai. Espelha
 * `knowledge-index.mjs` — "quem pensa", não "onde está X" (issue #29).
 *
 * Sem `night`, devolve o Provedor de hoje intacto — `cfg.model`/
 * `cfg.orientationModel`, os dois campos que já existiam antes desta issue
 * (ADR-0004) — para que um loop sem a flag não mude de comportamento.
 *
 * Com `night`, lê `cfg.nightProvider` direto — `loadConfig` já o mescla com
 * `DEFAULTS.nightProvider` um nível fundo (issue #40: o padrão do Provedor
 * mora só em `config.mjs`, `resolve` não carrega fallback próprio) — e
 * traduz o endereço de loopback pro host do Docker, porque o operador que
 * escreve `127.0.0.1` no config não deve ficar apontando pro próprio
 * container.
 */
export function resolve(cfg, { night = false } = {}) {
  if (!night) {
    return { kind: "anthropic", baseUrl: null, model: cfg.model, orientationModel: cfg.orientationModel };
  }
  const provider = cfg.nightProvider;
  return {
    kind: "local",
    baseUrl: translateLoopback(provider.baseUrl),
    model: provider.model,
    orientationModel: provider.orientationModel ?? provider.model,
    keepAlive: provider.keepAlive,
    minContext: provider.minContext,
  };
}

/**
 * Pares de ambiente que o processo `claude` precisa para falar com o
 * Provedor. `{}` para `anthropic` — a garantia de que um loop sem `--night`
 * roda com o ambiente idêntico ao de hoje, nenhuma variável nova injetada.
 *
 * O token é uma string qualquer não-vazia: o Ollama ignora o valor, mas o SDK
 * recusa a requisição sem ele.
 */
export function renderEnv(provider) {
  if (provider.kind !== "local") return {};
  return { ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_AUTH_TOKEN: "ralph-night-mode" };
}

/**
 * `prepare()` consulta isto para decidir se cobra credencial da Anthropic —
 * consequência direta de "falha alta, sem fallback" (ADR-0007): sem
 * fallback para o Claude pago, não há por que exigir a credencial dele
 * quando o Provedor é local.
 */
export function requiresAnthropicAuth(provider) {
  return provider.kind === "anthropic";
}

function joinUrl(baseUrl, urlPath) {
  return baseUrl.replace(/\/$/, "") + urlPath;
}

/**
 * Ferramenta e pedido da prova de `tool_use` (issue #32): um pedido que
 * **exige** a ferramenta pra responder, porque a capacidade `tools` que
 * `ollama show` anuncia mente — dois modelos medidos na máquina de
 * referência anunciam e reprovam, escrevendo a chamada como texto solto.
 */
const TOOL_USE_PROBE_TOOL = {
  name: "answer",
  description: "Reports the numeric result of the calculation.",
  input_schema: { type: "object", properties: { result: { type: "number" } }, required: ["result"] },
};
const TOOL_USE_PROBE_PROMPT = "What is 2 + 2? Use the `answer` tool to report the result — do not answer in plain text.";

const CANARY_START = "SENHA_INICIAL";
const CANARY_END = "SENHA_FINAL";
const CANARY_UNIT = "texto de preenchimento sem significado, só para ocupar espaço no contexto. ";
// Razão medida na máquina de referência da issue #29: 45 mil caracteres de
// CANARY_UNIT ocupam ~11 mil tokens. Arredonda pra cima na hora de converter
// minContext em caracteres — errar para menos aprova um servidor que não
// aguenta o contexto que o operador declarou, exatamente o que o canário
// existe para impedir (issue #42).
const CANARY_CHARS_PER_TOKEN = 45000 / 11000;

function canaryFiller(minContext) {
  const charsNeeded = Math.ceil(minContext * CANARY_CHARS_PER_TOKEN);
  const repeats = Math.ceil(charsNeeded / CANARY_UNIT.length);
  return CANARY_UNIT.repeat(repeats);
}

function canaryPrompt(minContext) {
  return (
    `${CANARY_START}\n\n${canaryFiller(minContext)}\n\n${CANARY_END}\n\n` +
    "Qual é a senha que aparece logo no início deste texto? Responda só com a senha, nada mais."
  );
}

/**
 * Teto de cada prova de `/v1/messages`, escolhido aqui (issue #56). O valor
 * é o mesmo que valia antes, mas ele deixou de ser herdado: até esta issue os
 * 300s vinham do `headersTimeout` do undici por baixo do `fetch` global —
 * nenhuma linha do projeto o escolheu, e uma mudança de default no Node
 * mudaria o comportamento do produto sem ninguém tocar no repositório.
 */
export const PROBE_TIMEOUT_MS = 300_000;

async function postMessages(fetchImpl, baseUrl, body) {
  const res = await fetchImpl(joinUrl(baseUrl, "/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/**
 * Distingue "o teto disparou" de qualquer outra falha do pedido. `fetch`
 * rejeita com `TimeoutError` quando o `AbortSignal.timeout` acima estoura, e
 * com `AbortError` nos abortos genéricos; um 500 do Provedor chega aqui como
 * `Error` comum e não é lentidão.
 */
function isTimeout(err) {
  const name = err?.name ?? err?.cause?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Impura, mas só de rede (issue #32): faz as três provas do Provedor local a
 * partir do host, com `fetch` nativo — zero dependência nova. Devolve
 * `{ reachable, toolUse, contextOk, contextTimedOut }`.
 *
 * Inalcançável (erro de rede ou `/api/tags` não responde) encurta as outras
 * duas provas para reprovadas: sem alcance não há como testar o resto, e uma
 * exceção de rede nunca escapa daqui — quem chama sempre recebe um objeto.
 *
 * A prova de contexto que não conclui em `PROBE_TIMEOUT_MS` volta como
 * `contextTimedOut` (issue #56), separada do truncamento: `contextOk` é falso
 * nos dois casos — o significado de hoje, para quem lê só ele —, mas só um
 * deles é prova de que o Provedor corta o prompt. `reachable` continua
 * verdadeiro: as pernas de alcance passaram, quem falhou foi a terceira prova.
 *
 * `tool_use` aprova só com bloco `tool_use` no `content` e
 * `stop_reason: "tool_use"` — chamada emitida como texto solto reprova, ainda
 * que o modelo anuncie a capacidade.
 *
 * O canário de contexto aprova só quando a resposta cita `SENHA_INICIAL` e
 * não cita `SENHA_FINAL` — citar a senha do fim é a prova de que o começo do
 * prompt foi cortado. O prompt cresce com `provider.minContext` (issue #42):
 * um servidor com contexto real menor que o declarado trunca o começo e
 * reprova, em vez de passar numa prova de tamanho fixo sem relação com o que
 * o operador configurou.
 */
export async function probe(provider, { fetchImpl = fetch } = {}) {
  const unreachable = { reachable: false, toolUse: false, contextOk: false, contextTimedOut: false };
  try {
    const tags = await fetchImpl(joinUrl(provider.baseUrl, "/api/tags"));
    if (!tags.ok) return unreachable;
  } catch {
    return unreachable;
  }

  let toolUse = false;
  try {
    const toolRes = await postMessages(fetchImpl, provider.baseUrl, {
      model: provider.model,
      max_tokens: 64,
      tools: [TOOL_USE_PROBE_TOOL],
      messages: [{ role: "user", content: TOOL_USE_PROBE_PROMPT }],
    });
    toolUse = toolRes.stop_reason === "tool_use" && (toolRes.content ?? []).some((b) => b.type === "tool_use");
  } catch {
    toolUse = false;
  }

  let contextOk = false;
  let contextTimedOut = false;
  try {
    const canaryRes = await postMessages(fetchImpl, provider.baseUrl, {
      model: provider.model,
      max_tokens: 64,
      messages: [{ role: "user", content: canaryPrompt(provider.minContext) }],
    });
    const answered = (canaryRes.content ?? []).map((b) => b.text ?? "").join("");
    contextOk = answered.includes(CANARY_START) && !answered.includes(CANARY_END);
  } catch (err) {
    contextOk = false;
    contextTimedOut = isTimeout(err);
  }

  return { reachable: true, toolUse, contextOk, contextTimedOut };
}

/**
 * Alcance provado de dentro do sandbox — quem consome o Provedor é o processo
 * `claude` de dentro, e `probe()` acima só prova o alcance a partir do host
 * (issue #32: "os dois têm de passar").
 *
 * Pedido HTTP com `curl`, o mesmo `/api/tags` que `probe()` faz do host, e não
 * um socket TCP direto (issue #46): o `docker sandbox` força todo o tráfego
 * por um proxy MITM em `host.docker.internal:3128` e o único destino que
 * responde a TCP direto é o próprio proxy — `/dev/tcp` reprovava qualquer
 * endereço, inclusive um Ollama que o `curl` de dentro alcançava com 200. O
 * `curl` respeita `HTTP_PROXY`/`HTTPS_PROXY`, então mede o caminho que o
 * consumidor real percorre. É ele e não o `fetch` nativo do Node (que a sonda
 * de embeddings usava até a issue #47, mesmo remédio aplicado lá também)
 * porque o `fetch` ignora as duas variáveis e abre socket direto — medido de
 * dentro do sandbox, falha contra o mesmo endereço que o `curl` alcança. Nada
 * novo entra no `bootstrap.sh`: a imagem do template já traz `/usr/bin/curl`.
 *
 * Teto de 5s, não os 2s que o `timeout` do TCP dava: o pedido agora atravessa
 * o proxy antes de chegar ao Provedor — mesmo teto que a sonda de embeddings
 * já usa (`knowledge-index`). A URL vem do config do operador e vai como
 * argumento posicional (`$1`), nunca interpolada no script, para que endereço
 * torto não vire comando dentro do container.
 */
export async function probeFromSandbox(sandboxName, provider, { execImpl = execCapture } = {}) {
  const result = await execImpl(sandboxName, [
    "bash",
    "-lc",
    'curl -fsS -o /dev/null --max-time 5 "$1"',
    "ralph-provider-probe",
    joinUrl(provider.baseUrl, "/api/tags"),
  ]);
  return { reachable: result.code === 0 };
}

/**
 * As duas provas de alcance combinadas num resultado só (issue #29: "os dois
 * têm de passar") — o host, que roda `tool_use` e o canário, e o sandbox, que
 * é quem de fato consome o Provedor durante a iteração. Ponto único de
 * verdade: `prepare()` (antes da iteração 1) e `ralph doctor` (issue #33)
 * precisavam exatamente da mesma combinação, e tê-la em dois lugares já
 * divergiu uma vez no code-review desta issue.
 *
 * `reachableFromHost`/`reachableFromSandbox` preservam as duas pernas (issue
 * #45) — antes só o `&&` sobrevivia em `reachable`, e `describeDegradation`
 * não conseguia distinguir qual perna reprovou para prescrever o comando
 * certo. `reachable` continua a conjunção derivada, para não quebrar quem já
 * lê só esse campo.
 */
export async function probeBoth(sandboxName, provider, opts = {}) {
  const [hostProbe, sandboxProbe] = await Promise.all([
    probe(provider, opts),
    probeFromSandbox(sandboxName, provider, opts),
  ]);
  return {
    ...hostProbe,
    reachableFromHost: hostProbe.reachable,
    reachableFromSandbox: sandboxProbe.reachable,
    reachable: hostProbe.reachable && sandboxProbe.reachable,
  };
}

/**
 * Aquece o Provedor local antes da iteração 1 (issue #34): um `/api/generate`
 * sem `prompt` só carrega o modelo na memória do Ollama e declara por quanto
 * tempo ele fica residente — a única escrita que o Ralph faz no Ollama do
 * operador, e ela expira sozinha (`keep_alive`), sem instalar, criar ou
 * reconfigurar nada.
 *
 * Nunca lança: falha ao aquecer não é falha alta (diferente das três provas
 * de `probe`) — a primeira iteração carrega o modelo sozinha, só mais devagar.
 * Quem chama decide como avisar.
 */
export async function preload(provider, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(joinUrl(provider.baseUrl, "/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: provider.model, keep_alive: provider.keepAlive }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Linha verde do `doctor` quando o Provedor local passa nas três provas
 * (issue #33). Fala do Provedor — o conceito do glossário —, não do Ollama;
 * o modelo é nomeado porque trocar `nightProvider.model` é a ação que o
 * operador tem disponível (a mesma correção que a issue #13 fez para a busca
 * semântica: nomear o processo só onde isso é acionável).
 *
 * `null` para o Provedor da API paga (issue #40) — a garantia de que a saída
 * do `doctor` sem night mode fica idêntica à de hoje vive aqui, na função
 * pura, e não só no gate do comando.
 */
export function describeAvailability(provider) {
  if (provider.kind !== "local") return null;
  return `Provedor local disponível (modelo ${provider.model})`;
}

/**
 * Uma prova de contexto que estourou o teto (`contextTimedOut`, issue #56)
 * é reportada como o que é, antes do caso do truncamento: o Provedor pode
 * estar íntegro, e mandar subir `OLLAMA_CONTEXT_LENGTH` ali piora exatamente
 * a lentidão que causou a falha. A ordem alcance → tool_use → timeout →
 * truncamento é o que garante que um Provedor inalcançável nunca receba a
 * prosa da lentidão.
 *
 * Prosa pro comando que conserta cada uma das três reprovações (CLAUDE.md:
 * "erro de usuário diz o comando que conserta"). Ordem importa: inalcançável
 * já reprova as outras duas em `probe()`, então checar alcance primeiro nunca
 * mostra um conserto de `tool_use`/canário para quem nem chegou lá. Sonda
 * aprovada em tudo devolve `null` — nenhuma linha pro `doctor` pintar.
 *
 * `minContext` prescreve o mesmo número que o canário exigiu (issue #42) —
 * quem chama passa `provider.minContext`, o mesmo valor que `probe()` usou
 * para dimensionar o prompt. `baseUrl` é o mesmo raciocínio para a issue
 * #45: dado do Provedor, não da sonda, e quem chama já tem `provider.baseUrl`
 * (já traduzido por `translateLoopback` em `resolve()`) em mãos.
 *
 * Host aprovado e sandbox reprovado (issue #45) é o caso comum sob
 * `docker sandbox` — o Ollama já está de pé, o problema é a rota do
 * container até ele. Mandar `OLLAMA_HOST=0.0.0.0` e reiniciar o serviço aí é
 * ruído: o operador já fez isso, e a saída não distinguia as duas pernas.
 *
 * O que conserta esse caso é uma coisa só, e não é reiniciar o Docker Desktop
 * (issue #51): a política de rede do sandbox bloqueia `::1/128` por padrão, e
 * é para lá que o proxy MITM resolve `host.docker.internal`. Medido, o proxy
 * tenta `::1` primeiro, bate na regra e devolve 500 sem sequer tentar o IPv4,
 * onde o Ollama está. `--allow-cidr ::1/128` é a única variante que abre a
 * rota: `--allow-host host.docker.internal`, `--allow-host "::1"` e
 * `--allow-host "[::1]:11434"` seguem em 500, porque `--allow-host` não vence
 * um bloqueio de CIDR. Daí a linha entregar o comando inteiro com o nome do
 * sandbox já interpolado, colável como está (padrão da issue #50).
 */
export function describeDegradation(probeResult, minContext, baseUrl, sandboxName) {
  if (!probeResult.reachable) {
    if (probeResult.reachableFromHost && !probeResult.reachableFromSandbox) {
      return (
        `Provedor local respondeu ao host em ${baseUrl}, mas o sandbox não alcançou o mesmo endereço. ` +
        "O Ollama já está de pé — reiniciar o serviço não resolve: a política de rede do sandbox " +
        "bloqueia o loopback do host. Para abrir a rota:\n\n" +
        `  docker sandbox network proxy ${sandboxName} --allow-cidr ::1/128`
      );
    }
    return "Provedor local inalcançável. Rode o Ollama do host com OLLAMA_HOST=0.0.0.0 e reinicie o serviço.";
  }
  if (!probeResult.toolUse) {
    return (
      "Provedor local não emite tool_use estruturado — o modelo escreve a chamada de ferramenta como texto, " +
      "mesmo anunciando a capacidade. Troque nightProvider.model em .ralph/config.json por um modelo que passe na prova."
    );
  }
  if (probeResult.contextTimedOut) {
    return (
      `Prova de contexto do Provedor local não concluiu em ${Math.round(PROBE_TIMEOUT_MS / 1000)}s. ` +
      "O Provedor respondeu — ele pode estar correto, só lento — e não se sabe se ele trunca o prompt. " +
      "Os consertos são baixar o contexto declarado, em nightProvider.minContext no .ralph/config.json e " +
      "em OLLAMA_CONTEXT_LENGTH no host, que precisam bater porque o Ralph nunca envia num_ctx e quem " +
      "dimensiona o KV cache é a variável do host; ou trocar nightProvider.model por um modelo que caiba " +
      "na GPU — `ollama ps` mostra a divisão CPU/GPU por trás da lentidão."
    );
  }
  if (!probeResult.contextOk) {
    return (
      "Provedor local trunca o prompt em silêncio antes do fim do contexto. Rode o Ollama do host com " +
      `OLLAMA_CONTEXT_LENGTH=${minContext} e reinicie o serviço — esse número e nightProvider.minContext ` +
      "são um par que precisa bater, porque o Ralph nunca envia num_ctx."
    );
  }
  return null;
}
