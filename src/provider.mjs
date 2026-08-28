import http from "node:http";
import https from "node:https";
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
    probeTimeoutSeconds: provider.probeTimeoutSeconds,
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
 * Cliente HTTP da biblioteca padrão, com a forma de retorno do `fetch` —
 * `{ ok, status, json() }` — para que a costura injetável de `probe()` não
 * mude de assinatura.
 *
 * Ele existe porque o teto do canário é do operador desde a issue #57, e o
 * `fetch` global não sabe honrar um teto acima de 300s: os 300s são o
 * `headersTimeout` do undici, que a API pública do Node não expõe — esticá-lo
 * exigiria um `Agent` do undici, que não é módulo built-in, e um
 * `AbortController` só encurta um teto, nunca o estende. Com um teto declarado
 * acima disso o `fetch` reprovaria o Provedor por um número que ninguém
 * escolheu, e a configuração do operador seria mentira.
 *
 * O teto entra por `opts.signal` e vale até o **corpo inteiro** ter chegado —
 * a promessa só resolve no `end` da resposta, e o abort continua armado até
 * lá. É o corpo que traz a resposta do canário: um teto que cobrisse só os
 * cabeçalhos aprovaria um Provedor que responde e nunca termina.
 *
 * Rejeita com o `reason` do próprio sinal, que é o que dá a `isTimeout()` o
 * `TimeoutError` do `AbortSignal.timeout` e o `AbortError` dos abortos
 * genéricos, exatamente como o `fetch` fazia.
 */
export function httpJson(url, { method = "GET", headers = {}, body, signal } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  // Em bytes, não em caracteres: o prompt do canário é português acentuado, e
  // um Content-Length curto faria o servidor ler menos corpo do que foi
  // enviado. Declará-lo evita o `transfer-encoding: chunked` que o Node usaria
  // sozinho, que o proxy MITM do sandbox não precisa entender.
  const payload = body === undefined ? null : Buffer.from(body);
  const sent = payload ? { ...headers, "content-length": payload.length } : headers;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      cleanup();
      reject(err);
    };
    function onAbort() {
      req.destroy();
      fail(signal.reason);
    }
    const req = transport.request(target, { method, headers: sent }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("error", fail);
      res.on("end", () => {
        if (settled) return;
        cleanup();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", fail);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Teto da prova de alcance a partir do host. Curto porque ela mede rota, não
 * inferência — o mesmo raciocínio (e o mesmo número) do `--max-time 5` que a
 * perna do sandbox usa contra o mesmo `/api/tags`.
 */
const REACH_TIMEOUT_MS = 5_000;

async function postMessages(fetchImpl, provider, body) {
  const res = await fetchImpl(joinUrl(provider.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.round(provider.probeTimeoutSeconds * 1000)),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/**
 * Distingue "o teto disparou" de qualquer outra falha do pedido. O cliente
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
 * partir do host, com o cliente `httpJson` acima — biblioteca padrão, zero
 * dependência nova. Devolve
 * `{ reachable, toolUse, contextOk, contextTimedOut }`.
 *
 * Inalcançável (erro de rede ou `/api/tags` não responde) encurta as outras
 * duas provas para reprovadas: sem alcance não há como testar o resto, e uma
 * exceção de rede nunca escapa daqui — quem chama sempre recebe um objeto.
 *
 * A prova de contexto que não conclui no teto do Provedor
 * (`probeTimeoutSeconds`, issue #57) volta como
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
export async function probe(provider, { fetchImpl = httpJson } = {}) {
  const unreachable = { reachable: false, toolUse: false, contextOk: false, contextTimedOut: false };
  try {
    const tags = await fetchImpl(joinUrl(provider.baseUrl, "/api/tags"), {
      signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    });
    if (!tags.ok) return unreachable;
  } catch {
    return unreachable;
  }

  let toolUse = false;
  try {
    const toolRes = await postMessages(fetchImpl, provider, {
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
    const canaryRes = await postMessages(fetchImpl, provider, {
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
 *
 * O teto é o mesmo `probeTimeoutSeconds` das provas, pelo mesmo cliente
 * `httpJson` (issue #60). Carregar dezenas de GB pode passar dos 300s que o
 * `fetch` global impõe, e na máquina que declarou 900s o aviso saía sobre um
 * aquecimento que ia bem, segundos antes de a iteração 1 rodar contra um
 * modelo já residente. Ter teto, e não deixá-lo aberto, é o outro lado: um
 * `preload` sem limite penduraria a iteração 1 e travaria o AFK a noite
 * inteira, que é pior que um aviso errado.
 */
export async function preload(provider, { fetchImpl = httpJson } = {}) {
  try {
    const res = await fetchImpl(joinUrl(provider.baseUrl, "/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: provider.model, keep_alive: provider.keepAlive }),
      signal: AbortSignal.timeout(Math.round(provider.probeTimeoutSeconds * 1000)),
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
 * Prosa que o `doctor --night` e o preparo da iteração imprimem **antes** de
 * bloquear na sonda (issue #58). Nada é medido e nada é decidido aqui: a
 * sonda continua sendo `probeBoth`, e o veredito continua vindo de
 * `describeDegradation`.
 *
 * Ela existe porque a sonda é a operação mais cara que o Ralph faz antes de
 * qualquer trabalho útil, e desde que o teto virou do operador (issue #57) a
 * espera pode passar de quinze minutos no padrão. Silêncio longo é
 * indistinguível de travamento, e o operador que não sabe que está esperando
 * mata o processo. Daí citar o teto vigente — o valor que o operador
 * declarou, não o padrão — e não só o fato de estar sondando: quem lê precisa
 * saber quanto a espera pode durar no pior caso. O teto é por prova, não do
 * bloqueio inteiro: `postMessages` arma o mesmo `probeTimeoutSeconds` nas duas
 * provas de inferência, e prometer o número como total mentiria pra quem
 * cronometra.
 *
 * `null` para o Provedor da API paga, mesma convenção de
 * `describeAvailability`: o modo diurno não ganha linha nova.
 */
export function describeProbeStart(provider) {
  if (provider.kind !== "local") return null;
  return (
    `Sondando o Provedor local em ${provider.baseUrl} (modelo ${provider.model}) — ` +
    `tool_use e canário de contexto, cada prova com teto de ${provider.probeTimeoutSeconds}s.`
  );
}

/**
 * Prosa pro comando que conserta cada reprovação da sonda (CLAUDE.md: "erro
 * de usuário diz o comando que conserta"). Sonda aprovada em tudo devolve
 * `null` — nenhuma linha pro `doctor` pintar. A ordem dos ramos é o
 * comportamento: alcance → timeout → tool_use → truncamento.
 *
 * Alcance vem primeiro porque um Provedor inalcançável já reprova as outras
 * provas dentro de `probe()` — checar alcance antes de tudo nunca mostra um
 * conserto de `tool_use`/canário para quem nem chegou lá.
 *
 * O timeout (`contextTimedOut`, issue #56) vem antes dos dois consertos
 * caros: o Provedor pode estar íntegro, e mandar subir `OLLAMA_CONTEXT_LENGTH`
 * piora exatamente a lentidão que causou a falha, enquanto trocar a tag do
 * modelo custa um `ollama pull` de dezenas de GB por um modelo que estava
 * correto.
 *
 * Que ele venha antes do `tool_use` (issue #59) vale sem a sonda distinguir
 * qual das pernas estourou, e o argumento é o tamanho dos dois prompts, não
 * uma medição: o canário é dimensionado por `minContext`, centenas de milhares
 * de caracteres, contra os ~100 bytes do pedido de `tool_use`. Um teto que a
 * prova pequena não alcança é um teto que a grande também não alcança, então
 * `contextTimedOut` deve ser verdadeiro sempre que a perna do `tool_use`
 * estourou por lentidão. Um Provedor que é lento **e** cujo modelo escreve a
 * chamada como texto recebe primeiro a prosa do teto, de propósito: na dúvida,
 * prescrever o conserto barato.
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
export function describeDegradation(probeResult, minContext, baseUrl, sandboxName, probeTimeoutSeconds) {
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
  if (probeResult.contextTimedOut) {
    return (
      `Prova do Provedor local não concluiu em ${probeTimeoutSeconds}s. ` +
      "O Provedor respondeu — ele pode estar correto, só lento — e não se sabe se ele trunca o prompt. " +
      "Se essa espera é aceitável, suba nightProvider.probeTimeoutSeconds no .ralph/config.json — o night " +
      "mode existe para gastar tempo de máquina ociosa, não para ser rápido. Os consertos que atacam a " +
      "lentidão em si são baixar o contexto declarado, em nightProvider.minContext no .ralph/config.json e " +
      "em OLLAMA_CONTEXT_LENGTH no host, que precisam bater porque o Ralph nunca envia num_ctx e quem " +
      "dimensiona o KV cache é a variável do host; ou trocar nightProvider.model por um modelo que caiba " +
      "na GPU — `ollama ps` mostra a divisão CPU/GPU por trás da lentidão."
    );
  }
  if (!probeResult.toolUse) {
    return (
      "Provedor local não emite tool_use estruturado — o modelo escreve a chamada de ferramenta como texto, " +
      "mesmo anunciando a capacidade. Troque nightProvider.model em .ralph/config.json por um modelo que passe na prova."
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
