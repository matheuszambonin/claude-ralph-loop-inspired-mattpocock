/**
 * Veredito sobre o `~/.claude/.credentials.json` que vive dentro do sandbox.
 *
 * `ralph login --share-credentials` copia o arquivo do host para o container:
 * a partir daí são duas cópias independentes. O access token vale horas e o
 * refresh **rotaciona** a cada renovação do host, o que invalida o refresh
 * congelado lá dentro. O arquivo continua no lugar e não-vazio — por isso
 * checar existência (o que o `isLoggedIn` fazia) deixava o `doctor` verde
 * enquanto a iteração morria com "OAuth session expired and could not be
 * refreshed". Os dois campos de expiração estão no próprio JSON: dá para
 * saber que venceu sem falar com a API.
 *
 * Módulo puro de propósito — quem lê o arquivo de dentro do container é o
 * runner, que é quem já sabe falar com o docker.
 */

/** Extrai as duas expirações (epoch ms). Devolve null se não der para ler. */
export function parse(raw) {
  if (!raw || !raw.trim()) return null;
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = json?.claudeAiOauth;
  if (!oauth || typeof oauth.expiresAt !== "number") return null;
  return {
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: typeof oauth.refreshTokenExpiresAt === "number" ? oauth.refreshTokenExpiresAt : null,
  };
}

/**
 * Compara a credencial do sandbox com a do host e diz o comando que conserta.
 *
 * `host` é opcional: só serve para distinguir a cópia velha (o host já
 * renovou, então o refresh de dentro do sandbox foi rotacionado e vai falhar)
 * de uma sessão que simplesmente venceu. As duas terminam em `ralph login`,
 * mas a primeira tem o atalho não-interativo.
 */
export function verdict({ sandbox, host = null, now = Date.now() }) {
  if (sandbox === null) {
    return {
      ok: false,
      message:
        "o Claude dentro do sandbox não está autenticado (sem ~/.claude/.credentials.json).\n" +
        "  Rode 'ralph login' e use /login lá dentro (uma vez por sandbox).",
    };
  }
  if (sandbox.refreshTokenExpiresAt !== null && sandbox.refreshTokenExpiresAt <= now) {
    return {
      ok: false,
      message:
        `a sessão do sandbox expirou de vez (refresh vencido ${ago(now - sandbox.refreshTokenExpiresAt)}).\n` +
        "  Rode 'ralph login' e use /login lá dentro.",
    };
  }
  if (sandbox.expiresAt <= now) {
    const stale = host !== null && host.expiresAt > sandbox.expiresAt;
    return {
      ok: false,
      message: stale
        ? `o token do sandbox venceu ${ago(now - sandbox.expiresAt)} e o host tem um mais novo — ` +
          "o refresh de lá dentro já foi rotacionado.\n" +
          "  Rode 'ralph login --share-credentials' para recopiar o token do host."
        : `o token do sandbox venceu ${ago(now - sandbox.expiresAt)}.\n` +
          "  Rode 'ralph login --share-credentials' (ou 'ralph login' e /login lá dentro).",
    };
  }
  return { ok: true, message: `claude autenticado no sandbox (token válido por mais ${ago(sandbox.expiresAt - now, "")})` };
}

/**
 * A falha de autenticação chega como resultado final da sessão, não como
 * código de saída falante: sem isto o usuário só vê "iteração falhou" e o
 * caminho de um JSONL de 5 KB.
 */
export function isAuthFailure(state) {
  return /failed to authenticate|oauth session expired|invalid api key/i.test(state?.finalResult ?? "");
}

/** "há 3h" / "há 2d" — grão grosso porque a decisão é binária, venceu ou não. */
function ago(ms, prefix = "há ") {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${prefix}${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${prefix}${hours}h`;
  return `${prefix}${Math.round(hours / 24)}d`;
}

/**
 * O conselho a imprimir quando a sessão morreu com `authentication_failed`.
 * Delega ao veredito porque é ele que sabe distinguir refresh morto (só
 * `ralph login` resolve) de cópia velha (recopiar do host basta).
 */
export function authFailureAdvice(v) {
  if (!v.ok) return v.message;
  // Os dois timestamps no futuro e a API recusando mesmo assim é o refresh
  // rotacionado pelo host (issue #8): o arquivo parece saudável e não está,
  // então nenhuma leitura de expiração pega este caso — só a recusa pega.
  return (
    "a credencial de lá dentro não vale mais, embora ainda não tenha vencido — " +
    "o host rotacionou o refresh.\n" +
    "  Rode 'ralph login --share-credentials' para recopiar o token do host."
  );
}
