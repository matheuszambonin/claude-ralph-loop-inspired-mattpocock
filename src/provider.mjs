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
/**
 * Orçamento de saída da prova de `tool_use`, o mesmo 64 de sempre — a folga da
 * issue #64 é só do canário, e a medição diz por quê: naquela corrida contra
 * `ornith:9b`, um modelo que raciocina, a reprovação que saiu foi a de
 * truncamento, e `describeDegradation` só chega lá com `toolUse` verdadeiro.
 * O raciocínio para chamar `answer` com `2 + 2` cabe nos 64; o raciocínio para
 * achar uma senha a cem mil tokens de distância não cabia.
 */
const TOOL_USE_MAX_TOKENS = 64;

/**
 * Orçamento de saída do canário, folgado de propósito (issue #64).
 *
 * Medido no repo alvo Terraços contra `ornith:9b`, com `minContext` 131072 e
 * teto de 64: `prompt_eval_count` 100201, `eval_count` 64, `response` vazio e
 * o raciocínio já com a senha certa em mãos. O modelo leu o prompt inteiro e
 * gastou o orçamento pensando, e o canário acusava truncamento de prompt.
 *
 * O conserto é teto, e não ler o bloco de raciocínio — o argumento inteiro está
 * no doc de `probe()`, junto do critério que ele protege.
 */
const CANARY_MAX_TOKENS = 1024;

const CANARY_START = "SENHA_INICIAL";
const CANARY_END = "SENHA_FINAL";
const CANARY_UNIT = "texto de preenchimento sem significado, só para ocupar espaço no contexto. ";
/**
 * Razão de fallback, medida na máquina de referência da issue #29: 45 mil
 * caracteres de `CANARY_UNIT` ocupam ~11 mil tokens.
 *
 * Ela deixou de dimensionar o canário na issue #55 e só entra quando a
 * calibragem não tem o que ler — Provedor que responde sem `usage`. A
 * aprovação que sai daí vem marcada como não provada, porque é estimativa.
 *
 * Duas medições dizem por que ela não podia continuar sendo a régua: 4,41
 * contra `qwen3-coder:30b-a3b-q4_K_M` e 5,353 contra `ornith:9b`. As duas não
 * divergem por erro de medição, divergem porque a razão é propriedade do
 * tokenizer do modelo. Não há constante certa para escrever aqui.
 *
 * Continua sendo 4,091 e não 5,353 justamente por ser fallback: errando para
 * menos ela aprova um Provedor que não provou o tamanho todo, e o texto da
 * aprovação diz isso; errando para mais ela estoura 21% num modelo de razão
 * 4,4 e acusa de truncamento quem está íntegro.
 */
const CANARY_CHARS_PER_TOKEN = 45000 / 11000;

/**
 * Amostras da calibragem, em caracteres de `CANARY_UNIT` puro.
 *
 * Dois pontos e não um: o `input_tokens` de um pedido traz junto o envelope do
 * chat (template do modelo, marcadores de papel, system prompt injetado), que
 * não é filler. Ele é grande — 1226 tokens contra `devstral:24b` —, e com um
 * ponto só a razão sairia baixa na mesma proporção. Idêntico nos dois pedidos,
 * ele some na subtração.
 *
 * Amostras pequenas de propósito: elas custam prefill antes da prova cara. A
 * diferença entre as duas contagens é ~800 tokens, e é ela que dá a resolução
 * da razão — veja `CANARY_PROOF_SLACK`, que existe para absorver isso.
 */
const CANARY_CALIBRATION_CHARS = [4000, 8000];

/**
 * Faixa em que uma razão medida é crível — nenhum tokenizer de texto natural
 * sai dela. Existe porque a razão vira tamanho de string: Provedor que devolve
 * `usage` torta, com as duas amostras contadas igual ou quase, faria o
 * `repeat()` abaixo pedir centenas de megabytes, e a sonda morreria de
 * `RangeError` em vez de reprovar.
 */
const CANARY_RATIO_MIN = 1;
const CANARY_RATIO_MAX = 8;

/**
 * Caracteres de `CANARY_UNIT` que ocupam `tokens` tokens no Provedor, dada a
 * razão. Pura de propósito (issue #55): a razão entra como argumento porque é
 * propriedade do tokenizer do modelo, e tê-la fixa numa constante foi o defeito
 * que este parâmetro conserta.
 */
export function canaryFiller(tokens, charsPerToken) {
  const charsNeeded = Math.ceil(tokens * charsPerToken);
  const repeats = Math.ceil(charsNeeded / CANARY_UNIT.length);
  return CANARY_UNIT.repeat(repeats);
}

function canaryPrompt(fillerTokens, charsPerToken) {
  return (
    `${CANARY_START}\n\n${canaryFiller(fillerTokens, charsPerToken)}\n\n${CANARY_END}\n\n` +
    "Qual é a senha que aparece logo no início deste texto? Responda só com a senha, nada mais."
  );
}

/**
 * Quantos tokens o canário se propõe a provar: o declarado menos o orçamento
 * de saída.
 *
 * O `num_ctx` do Ollama cobre prompt mais resposta, então um prompt de
 * exatamente `minContext` estoura no Provedor cujo `OLLAMA_CONTEXT_LENGTH` bate
 * com o declarado — o par que `describeDegradation` prescreve. Ele truncaria a
 * frente e reprovaria por integridade que tem. A banda entre alvo e declarado é
 * o próprio teto de saída: 0,78% em 131072.
 *
 * O piso em zero é para o `minContext` menor que o próprio orçamento de saída,
 * que o config aceita (só exige inteiro positivo): ali não sobra nada para
 * provar, e sem o piso o `repeat()` de `canaryFiller` lançaria `RangeError`
 * com contagem negativa — exceção que a sonda engole e devolve como veredito
 * sobre o modelo.
 */
function canaryTarget(minContext) {
  return Math.max(0, minContext - CANARY_MAX_TOKENS);
}

/**
 * Folga do piso da conferência, em fração do alvo.
 *
 * A razão sai da divisão de dois inteiros, então ela carrega a resolução da
 * própria calibragem: ±1 token em cada contagem move o prompt final em
 * ~2/(T2−T1) do tamanho pedido, uns 0,2% com as amostras de 4 e 8 mil
 * caracteres. Medido em simulação, isso põe a prova 41 tokens abaixo do alvo
 * num Provedor de razão 4,41 com 131072 declarados — o piso cru reprovaria por
 * arredondamento, que é a sonda acusando o Provedor de um erro dela.
 *
 * Meio por cento cobre essa resolução com folga de duas vezes e ainda pega o
 * que a issue #55 mediu: 7,3% num modelo e 24% no outro.
 */
const CANARY_PROOF_SLACK = 0.005;

function canaryProofFloor(minContext) {
  return Math.floor(canaryTarget(minContext) * (1 - CANARY_PROOF_SLACK));
}

/**
 * Quanto filler o canário precisa para que o prompt **inteiro** meça o alvo:
 * o alvo menos o envelope do chat, menos as senhas e a pergunta.
 *
 * O envelope entra aqui porque medi-lo desmentiu a estimativa da triagem, que
 * o supunha de 10 a 20 tokens: contra `devstral:24b` no Ollama 0.33.0 ele são
 * **1226**, um system prompt inteiro que o template do modelo injeta. Sem
 * descontá-lo, um alvo de 3072 vira um prompt de 4341 — 41% acima do pedido, e
 * acima do próprio `minContext` declarado. O Provedor cujo
 * `OLLAMA_CONTEXT_LENGTH` bate com o declarado truncaria a frente e reprovaria
 * por integridade que tem, que é exatamente o que `canaryTarget` existe para
 * evitar. Reservar 1024 tokens não adianta contra um envelope maior que isso.
 *
 * Ele é medido junto com a razão e não estimado, pela mesma razão de tudo aqui:
 * é propriedade do template do modelo, e o próximo modelo tem outro.
 */
function canaryFillerTokens(minContext, { charsPerToken, envelopeTokens }) {
  const scaffold = Math.ceil(canaryPrompt(0, charsPerToken).length / charsPerToken);
  return Math.max(0, canaryTarget(minContext) - envelopeTokens - scaffold);
}

/**
 * Cliente HTTP da biblioteca padrão, com a forma de retorno do `fetch` —
 * `{ ok, status, headers, json() }` — para que a costura injetável de `probe()`
 * não mude de assinatura.
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
 * Ele não segue redirect, e isso é escolha, não esquecimento (issue #61):
 * seguir 3xx à mão custa detecção de laço, reescrita de método no 303 e corte
 * de cabeçalho ao trocar de origem — superfície nova, num projeto de zero
 * dependência, para uma sonda que fala com um Ollama de loopback. A perna do
 * sandbox usa `curl -fsS`, que também não segue, e fazer só esta seguir seria
 * as duas metades da sonda discordando sobre o mesmo `baseUrl`. O `-f` só
 * reprova em 4xx e 5xx, então contra um 3xx aquela perna sai com código zero e
 * aprova: quem enxerga o redirect é esta, e é daqui que o diagnóstico tem de
 * sair. Por isso o 3xx sai como resposta não-ok com os cabeçalhos junto, para
 * `describeDegradation` poder dizer que foi redirect e para onde.
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
          headers: res.headers,
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

/**
 * Redirect visto numa resposta da sonda, ou `null` para qualquer outra coisa
 * — inclusive um 500, que é falha do Provedor e não do endereço.
 *
 * Existe porque o cliente não segue 3xx (veja `httpJson`), e sem este dado a
 * resposta chegaria a `describeDegradation` como um não-2xx qualquer: o
 * operador que apontou `nightProvider.baseUrl` para um proxy recebia um
 * diagnóstico sobre inferência para um problema de endereço.
 *
 * O `location` vem do objeto de cabeçalhos do Node, já em minúsculas, e pode
 * faltar — 3xx sem `Location` é resposta torta, mas continua sendo redirect.
 * O 304 é a exceção: ele não manda a sonda a lugar nenhum, e chamá-lo de
 * redirect prescreveria trocar um `baseUrl` que está certo.
 */
function redirectOf(res) {
  if (!(res.status >= 300 && res.status < 400) || res.status === 304) return null;
  return { status: res.status, location: res.headers?.location ?? null };
}

async function postMessages(fetchImpl, provider, body) {
  const res = await fetchImpl(joinUrl(provider.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.round(provider.probeTimeoutSeconds * 1000)),
  });
  // O `redirect` viaja no erro porque é o único caminho de volta daqui: quem
  // chama só vê a exceção, e sem ele um 3xx chegaria à prosa como não-2xx
  // qualquer (issue #61).
  if (!res.ok) throw Object.assign(new Error(`status ${res.status}`), { redirect: redirectOf(res) });
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
 * Mede o tamanho que este Provedor dá ao texto do canário (issue #55):
 * `{ charsPerToken, envelopeTokens }`, ou `null` quando não dá para medir.
 *
 * Dois pedidos de filler puro — sem senha, sem pergunta, sem `tools` —, a razão
 * saindo da diferença entre as duas contagens de `usage.input_tokens`. É o que
 * substitui a estimativa por constante: a razão é do tokenizer do modelo, e
 * qualquer número escrito no código só vale para o modelo em que foi medido.
 *
 * O envelope é o que sobra de uma contagem depois de descontar o filler pela
 * razão: o template do modelo, os marcadores de papel e o system prompt que o
 * Ollama injeta sozinho. Ele cancela na subtração que dá a razão, e é por isso
 * que os pontos são dois; a subtração não o faz sumir do prompt final, e
 * `canaryFillerTokens` é quem cuida disso.
 *
 * `max_tokens: 1` nos dois: nenhum byte da resposta é lido, só o `usage`. A
 * lição da issue #64 (não ler o bloco de raciocínio) não alcança aqui, porque
 * lá o critério dependia do texto.
 *
 * Teto igual ao das outras pernas, sem botão novo no config: são dois pedidos
 * de mil tokens, e a perna de `tool_use` já rodou antes e absorveu o
 * carregamento do modelo na GPU (issue #60). O timeout sobe para quem chama —
 * um teto que a prova pequena não alcança é um teto que a grande também não
 * alcança (issue #59), e o pedido grande nem chega a sair.
 */
async function calibrate(fetchImpl, provider) {
  // Razão 1 é um caractere por token, que aqui é só o jeito de pedir um filler
  // de N caracteres pela mesma função que monta o do canário.
  const samples = CANARY_CALIBRATION_CHARS.map((chars) => canaryFiller(chars, 1));
  const counted = [];
  for (const content of samples) {
    const res = await postMessages(fetchImpl, provider, {
      model: provider.model,
      max_tokens: 1,
      messages: [{ role: "user", content }],
    });
    const tokens = res.usage?.input_tokens;
    if (typeof tokens !== "number") return null;
    counted.push(tokens);
  }
  const charsPerToken = (samples[1].length - samples[0].length) / (counted[1] - counted[0]);
  if (!(charsPerToken >= CANARY_RATIO_MIN && charsPerToken <= CANARY_RATIO_MAX)) return null;
  const envelopeTokens = Math.max(0, Math.round(counted[0] - samples[0].length / charsPerToken));
  return { charsPerToken, envelopeTokens };
}

/**
 * Impura, mas só de rede (issue #32): faz as três provas do Provedor local a
 * partir do host, com o cliente `httpJson` acima — biblioteca padrão, zero
 * dependência nova. Devolve
 * `{ reachable, toolUse, contextOk, contextTimedOut, outputExhausted, contextTokens, redirect }`.
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
 *
 * Ele mede o próprio tamanho antes de montá-lo (issue #55): `calibrate()` roda
 * primeiro, e a razão que sai de lá é a que converte tokens em caracteres. A
 * constante existia porque medir parecia caro, e a medição mostrou que ela
 * errava 7% num modelo e 24% em outro, sempre aprovando menos contexto do que o
 * operador declarou. O alvo é `canaryTarget(minContext)`, não o declarado
 * cheio, e a conferência é piso (`canaryProofFloor`): mais tokens que o pedido,
 * com a senha do início na resposta, é o Provedor provando mais do que foi
 * exigido.
 *
 * Não reescala. Repetir o pedido grande para acertar o tamanho paga o prefill
 * duas vezes — 2153s num único pedido de 131k na medição da issue #54 —, e
 * medir antes é justamente o que torna o reescalar desnecessário.
 *
 * `contextTokens` são os tokens que a prova alcançou, ou `null` quando não deu
 * para medir. Número e não booleano porque é o que o operador precisa saber: é
 * a única capacidade do Provedor que o `doctor` mede em vez de repetir do
 * config. Ele só se pronuncia com `contextOk` verdadeiro, e a regra é dura: um
 * servidor que trunca reporta o `input_tokens` de depois do corte, então
 * "menos tokens que o alvo" seria ambíguo entre a sonda ter se medido mal e o
 * servidor ter cortado. A senha desempata, e é para isso que ela existe.
 *
 * O critério lê só os blocos de texto, e isso é escolha (issue #64): o modelo
 * que raciocina antes de responder cita as duas senhas enquanto pensa, e
 * aceitar o raciocínio como resposta apagaria a distinção que a prova existe
 * para fazer — o canário passaria a reprovar o Provedor íntegro por outro
 * motivo, ou deixaria de reprovar o que trunca. O que faltava ao modelo que
 * pensa não era leitura, era teto de saída (veja `CANARY_MAX_TOKENS`).
 *
 * `outputExhausted` (issue #64) é o canário que voltou sem texto no teto de
 * saída — `stop_reason: "max_tokens"` —, o modelo que gastou o orçamento
 * pensando. `contextOk` é falso aqui também, mas a inferência rodou inteira:
 * nada foi truncado, e a prosa não pode herdar a frase de truncamento.
 *
 * `redirect` (issue #61) é o 3xx que qualquer uma das três pernas viu, com o
 * destino do `Location`, ou `null`. Ele não é um veredito a mais: a perna que
 * o recebeu já reprovou, como reprovaria com qualquer não-2xx. Ele existe para
 * que a prosa possa falar de endereço quando foi endereço, em vez de acusar o
 * modelo por uma resposta que nunca chegou a ser inferência.
 */
export async function probe(provider, { fetchImpl = httpJson } = {}) {
  const unreachable = {
    reachable: false,
    toolUse: false,
    contextOk: false,
    contextTimedOut: false,
    outputExhausted: false,
    contextTokens: null,
    redirect: null,
  };
  try {
    const tags = await fetchImpl(joinUrl(provider.baseUrl, "/api/tags"), {
      signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    });
    if (!tags.ok) return { ...unreachable, redirect: redirectOf(tags) };
  } catch {
    return unreachable;
  }

  // O primeiro redirect visto vence: as duas provas de inferência falam com o
  // mesmo endereço, e repetir o diagnóstico não acrescenta nada.
  let redirect = null;

  let toolUse = false;
  try {
    const toolRes = await postMessages(fetchImpl, provider, {
      model: provider.model,
      max_tokens: TOOL_USE_MAX_TOKENS,
      tools: [TOOL_USE_PROBE_TOOL],
      messages: [{ role: "user", content: TOOL_USE_PROBE_PROMPT }],
    });
    toolUse = toolRes.stop_reason === "tool_use" && (toolRes.content ?? []).some((b) => b.type === "tool_use");
  } catch (err) {
    toolUse = false;
    redirect ??= err?.redirect ?? null;
  }

  let contextOk = false;
  let contextTimedOut = false;
  let outputExhausted = false;
  let contextTokens = null;

  // A calibragem vem antes do canário e pode encerrar a prova sozinha: teto
  // estourado aqui é teto estourado lá, e o pedido grande não sai.
  //
  // Sem medida, o canário volta ao dimensionamento de antes da issue #55: a
  // constante e envelope nenhum. Ele erra para mais e para menos, e é por isso
  // que a aprovação que sai dali vem marcada como não provada.
  let sizing = { charsPerToken: CANARY_CHARS_PER_TOKEN, envelopeTokens: 0 };
  try {
    sizing = (await calibrate(fetchImpl, provider)) ?? sizing;
  } catch (err) {
    redirect ??= err?.redirect ?? null;
    if (isTimeout(err)) {
      return { reachable: true, toolUse, contextOk, contextTimedOut: true, outputExhausted, contextTokens, redirect };
    }
  }

  try {
    const canaryRes = await postMessages(fetchImpl, provider, {
      model: provider.model,
      max_tokens: CANARY_MAX_TOKENS,
      messages: [
        { role: "user", content: canaryPrompt(canaryFillerTokens(provider.minContext, sizing), sizing.charsPerToken) },
      ],
    });
    // Só os blocos de texto: é aqui que o raciocínio fica de fora (issue #64).
    const answered = (canaryRes.content ?? []).map((b) => b.text ?? "").join("");
    contextOk = answered.includes(CANARY_START) && !answered.includes(CANARY_END);
    // Texto vazio no teto de saída: a inferência rodou inteira e não sobrou
    // orçamento pra resposta. Estado distinto de prompt truncado, e o critério
    // acima não o distingue sozinho.
    //
    // Exige texto vazio de propósito. Quem escreveu a senha do fim antes de
    // bater no teto provou o truncamento, e continua reprovando por ele. E
    // texto parcial sem senha nenhuma é ambíguo: dizer ali que o Provedor leu
    // o prompt inteiro seria afirmar o que não foi provado, e o vazio é o caso
    // que a medição do ticket mostra.
    outputExhausted = canaryRes.stop_reason === "max_tokens" && answered.trim() === "";
    // Só com a senha do início em mãos: sem ela, um `input_tokens` baixo não
    // distingue prompt curto de prompt cortado.
    const read = canaryRes.usage?.input_tokens;
    contextTokens = contextOk && typeof read === "number" ? read : null;
  } catch (err) {
    contextOk = false;
    contextTimedOut = isTimeout(err);
    redirect ??= err?.redirect ?? null;
  }

  return { reachable: true, toolUse, contextOk, contextTimedOut, outputExhausted, contextTokens, redirect };
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
 *
 * Com o resultado da sonda em mãos (issue #55), a linha diz quantos tokens o
 * canário provou contra quantos o operador declarou. É a única saída do
 * `doctor` que informa capacidade medida em vez de repetir o que está no
 * config, e por isso ela não some quando a medição falha: o canário que rodou
 * por estimativa aprova dizendo que o tamanho não foi provado, em vez de deixar
 * a aprovação parecer a mesma dos outros dias.
 */
export function describeAvailability(provider, probeResult = null) {
  if (provider.kind !== "local") return null;
  const line = `Provedor local disponível (modelo ${provider.model})`;
  if (!probeResult) return line;
  if (probeResult.contextTokens == null) {
    return (
      `${line}, com o tamanho do contexto não provado: o Provedor respondeu sem a contagem de tokens do ` +
      "prompt, e o canário foi dimensionado por estimativa."
    );
  }
  return `${line}, ${probeResult.contextTokens} tokens de contexto provados contra ${provider.minContext} declarados`;
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
 * A calibragem do canário (issue #55) é anunciada como etapa dele, não como
 * quarta prova: ela não tem veredito próprio, e contá-la junto faria o operador
 * procurar um quarto resultado que nunca aparece. Está aqui porque são dois
 * pedidos a mais antes do silêncio longo, e quem cronometra precisa saber que
 * o relógio já começou.
 *
 * `null` para o Provedor da API paga, mesma convenção de
 * `describeAvailability`: o modo diurno não ganha linha nova.
 */
export function describeProbeStart(provider) {
  if (provider.kind !== "local") return null;
  return (
    `Sondando o Provedor local em ${provider.baseUrl} (modelo ${provider.model}) — ` +
    `tool_use e canário de contexto, cada prova com teto de ${provider.probeTimeoutSeconds}s. ` +
    "O canário mede quantos tokens o Provedor conta antes de montar o prompt grande."
  );
}

/**
 * Prosa pro comando que conserta cada reprovação da sonda (CLAUDE.md: "erro
 * de usuário diz o comando que conserta"). Sonda aprovada em tudo devolve
 * `null` — nenhuma linha pro `doctor` pintar. A ordem dos ramos é o
 * comportamento: redirect → alcance → timeout → tool_use → orçamento de saída →
 * truncamento → prova aquém do alvo.
 *
 * O redirect (issue #61) vem antes de tudo porque ele explica as reprovações
 * que vêm depois, e nenhuma delas explica o redirect: um 3xx em `/api/tags`
 * chega aqui como Provedor inalcançável, e um 3xx em `/v1/messages` chega
 * como modelo que não emite `tool_use`. Nos dois casos o operador levaria um
 * conserto caro (reiniciar o Ollama, baixar outro modelo) por um `baseUrl`
 * mediado. A sonda não segue o redirect por escolha (veja `httpJson`), então
 * o conserto é declarar o destino final.
 *
 * Ele vence até o caso de host aprovado e sandbox reprovado, que perde aqui o
 * comando da política de rede: um `baseUrl` que redireciona está errado para
 * as duas pernas, e mandar abrir a rota até um endereço que não é o final é
 * pedir o segundo conserto antes do primeiro. Consertado o endereço, a sonda
 * volta a reprovar pela rota, com o comando de sempre.
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
 * O orçamento de saída esgotado (`outputExhausted`, issue #64) vem logo antes
 * do truncamento porque é a mesma prova reprovando por outra causa, e a causa
 * é conhecida: o `stop_reason` disse. Prescrever `OLLAMA_CONTEXT_LENGTH` aqui
 * manda o operador reconfigurar o host por um problema que não é de contexto,
 * e é o Provedor íntegro que paga — ele leu o prompt inteiro.
 *
 * A prova aquém do alvo (issue #55) fica por último porque só existe depois de
 * o canário aprovar: com `contextOk` verdadeiro a senha do início voltou, o
 * prompt não foi cortado, e o que sobrou é a sonda ter se dimensionado abaixo
 * do que prometeu provar. Vir antes do truncamento inverteria a leitura de um
 * `input_tokens` baixo, que num servidor que corta é a contagem de depois do
 * corte. A prosa assume a culpa e não manda reconfigurar o host por um bug
 * nosso.
 *
 * Prova sem medida — `contextTokens` nulo, Provedor que responde sem `usage` —
 * aprova. O tamanho não foi provado, e quem diz isso é a linha de aprovação de
 * `describeAvailability`: reprovar aqui mataria o loop de um Provedor íntegro
 * por causa de um campo que ele não devolve, que é a falha que as issues #56,
 * #59, #60 e #64 consertaram uma de cada vez.
 *
 * `minContext` prescreve o mesmo número que o canário exigiu (issue #42) —
 * quem chama passa `provider.minContext`, o mesmo valor de que `probe()` tira
 * o alvo do prompt. É o declarado que vai para a prosa, e não o alvo: o par com
 * `OLLAMA_CONTEXT_LENGTH` é sobre o contexto do host, que precisa caber prompt
 * e resposta. `baseUrl` é o mesmo raciocínio para a issue
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
  if (probeResult.redirect) {
    const { status, location } = probeResult.redirect;
    const target = location ? `um redirect para ${location}` : "um redirect sem cabeçalho Location";
    return (
      `Provedor local respondeu ${status} em ${baseUrl}, ${target}. A sonda não segue redirect por ` +
      "escolha, então o endereço declarado nunca chega a ser provado. Declare o destino final em " +
      "nightProvider.baseUrl no .ralph/config.json."
    );
  }
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
  if (probeResult.outputExhausted) {
    return (
      "Provedor local leu o prompt do canário inteiro e não sobrou orçamento de saída: a resposta veio vazia, " +
      `com os ${CANARY_MAX_TOKENS} tokens do teto gastos no raciocínio. O contexto do Provedor está ` +
      "fora de suspeita — a inferência rodou até o fim. Troque nightProvider.model em .ralph/config.json por um " +
      "modelo que feche o raciocínio e ainda responda dentro desse teto, ou desligue o raciocínio do modelo atual."
    );
  }
  if (!probeResult.contextOk) {
    return (
      "Provedor local trunca o prompt em silêncio antes do fim do contexto. Rode o Ollama do host com " +
      `OLLAMA_CONTEXT_LENGTH=${minContext} e reinicie o serviço — esse número e nightProvider.minContext ` +
      "são um par que precisa bater, porque o Ralph nunca envia num_ctx."
    );
  }
  // Daqui pra baixo o canário passou: a senha do início voltou, e o Provedor
  // está fora de suspeita. O que resta é o tamanho que a prova de fato alcançou
  // (issue #55).
  if (probeResult.contextTokens == null) return null;
  if (probeResult.contextTokens < canaryProofFloor(minContext)) {
    return (
      `Provedor local leu o prompt do canário inteiro, mas o canário nasceu curto: provou ` +
      `${probeResult.contextTokens} tokens contra os ${minContext} de nightProvider.minContext. O Provedor está ` +
      "fora de suspeita e o host não tem o que consertar — quem errou o próprio tamanho foi a sonda, e subir " +
      `OLLAMA_CONTEXT_LENGTH não muda esta linha. Enquanto ela aparecer, ${probeResult.contextTokens} é o ` +
      "contexto que você tem provado: declarar esse número em nightProvider.minContext no .ralph/config.json, " +
      "com OLLAMA_CONTEXT_LENGTH do host acompanhando, é a saída que não mente sobre o tamanho."
    );
  }
  return null;
}
