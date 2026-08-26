import { dockerHostAddress, translateLoopback } from "./paths.mjs";

/**
 * Padrão do Provedor local (issue #29, "O que foi medido, e onde"): tag
 * validada nas três provas do Ollama contra a máquina de referência do
 * documento da épica — não um chute. `orientationModel: null` = a Orientação
 * herda o modelo da iteração (ADR-0007: um Provedor por processo, dois
 * modelos possíveis dentro dele).
 */
export const DEFAULT_NIGHT_PROVIDER = {
  baseUrl: `http://${dockerHostAddress()}:11434`,
  model: "qwen3-coder:30b-a3b-q4_K_M",
  orientationModel: null,
};

/**
 * Pura: config e a flag `--night` entram, o Provedor resolvido sai. Espelha
 * `knowledge-index.mjs` — "quem pensa", não "onde está X" (issue #29).
 *
 * Sem `night`, devolve o Provedor de hoje intacto — `cfg.model`/
 * `cfg.orientationModel`, os dois campos que já existiam antes desta issue
 * (ADR-0004) — para que um loop sem a flag não mude de comportamento.
 *
 * Com `night`, mescla `cfg.nightProvider` sobre `DEFAULT_NIGHT_PROVIDER`
 * (`cfg.nightProvider` ausente cai inteiro no padrão, sem lançar) e traduz o
 * endereço de loopback pro host do Docker — o operador que escreve
 * `127.0.0.1` no config não fica apontando pro próprio container.
 */
export function resolve(cfg, { night = false } = {}) {
  if (!night) {
    return { kind: "anthropic", baseUrl: null, model: cfg.model, orientationModel: cfg.orientationModel };
  }
  const provider = { ...DEFAULT_NIGHT_PROVIDER, ...cfg.nightProvider };
  return {
    kind: "local",
    baseUrl: translateLoopback(provider.baseUrl),
    model: provider.model,
    orientationModel: provider.orientationModel ?? provider.model,
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
