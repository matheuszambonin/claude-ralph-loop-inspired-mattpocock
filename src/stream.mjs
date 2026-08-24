/**
 * Renderizador do `--output-format stream-json` do Claude Code.
 *
 * Faz o papel que o filtro jq faz nos artigos do aihero.dev, mas em Node:
 * a máquina não tem jq, e o parsing de JSON aqui é mais tolerante a linhas
 * partidas do que um pipe `grep '^{' | jq --unbuffered`.
 */

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  magenta: "[35m",
  cyan: "[36m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);

/** Resumo de uma linha para o uso de uma ferramenta. */
function describeTool(name, input = {}) {
  const first = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === "string");
  switch (name) {
    case "Bash":
      return input.command?.split("\n")[0]?.slice(0, 120) ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return first("file_path", "notebook_path") ?? "";
    case "Grep":
    case "Glob":
      return [input.pattern, input.path].filter(Boolean).join("  ").slice(0, 120);
    case "Task":
    case "Agent":
      return first("description", "subagent_type") ?? "";
    case "Skill":
      return [input.skill, input.args].filter(Boolean).join(" ").slice(0, 120);
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return `${done}/${todos.length} concluídos`;
    }
    default: {
      const guess = first("file_path", "path", "query", "prompt", "url", "command");
      return guess ? guess.slice(0, 120) : "";
    }
  }
}

export function createStreamRenderer({ onEvent } = {}) {
  const state = { text: "", finalResult: null, costUsd: 0, turns: 0, isError: false, sessionId: null, skills: null, mcpServers: null };

  function handle(evt) {
    onEvent?.(evt);
    switch (evt.type) {
      case "system":
        if (evt.subtype === "init") {
          state.sessionId = evt.session_id ?? null;
          if (evt.skills !== undefined) state.skills = evt.skills;
          if (evt.mcp_servers !== undefined) state.mcpServers = evt.mcp_servers;
          const tools = Array.isArray(evt.tools) ? evt.tools.length : "?";
          const skills = Array.isArray(evt.skills) ? evt.skills.length : null;
          process.stdout.write(
            paint(C.dim, `  sessão ${String(evt.session_id).slice(0, 8)} · modelo ${evt.model ?? "?"} · ${tools} ferramentas${skills !== null ? ` · ${skills} skills` : ""}\n\n`)
          );
        }
        break;

      case "assistant": {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            state.text += block.text;
            process.stdout.write(block.text.replace(/\n/g, "\n") + "\n\n");
          } else if (block.type === "tool_use") {
            const detail = describeTool(block.name, block.input);
            process.stdout.write(
              `${paint(C.cyan, "⚙")} ${paint(C.bold, block.name)}${detail ? paint(C.dim, "  " + detail) : ""}\n`
            );
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            const preview = block.thinking.trim().split("\n")[0].slice(0, 100);
            process.stdout.write(paint(C.dim, `  ⋯ ${preview}\n`));
          }
        }
        break;
      }

      case "user": {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "tool_result" && block.is_error) {
            const body = typeof block.content === "string"
              ? block.content
              : (block.content ?? []).map((c) => c.text ?? "").join(" ");
            process.stdout.write(paint(C.red, `  ✗ ${body.split("\n")[0].slice(0, 160)}\n`));
          }
        }
        break;
      }

      case "result": {
        state.finalResult = evt.result ?? state.text;
        state.costUsd = evt.total_cost_usd ?? 0;
        state.turns = evt.num_turns ?? 0;
        state.isError = evt.is_error === true || evt.subtype !== "success";
        const secs = ((evt.duration_ms ?? 0) / 1000).toFixed(0);
        const cost = state.costUsd ? `$${state.costUsd.toFixed(4)}` : "—";
        process.stdout.write(
          paint(C.dim, `\n  ${state.turns} turnos · ${secs}s · ${cost}\n`)
        );
        break;
      }
    }
  }

  /** Alimenta o renderizador com um pedaço bruto de stdout do claude. */
  let buffer = "";
  function write(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* linha JSON truncada ou ruído: ignora, como o `grep '^{'` do artigo */
      }
    }
  }

  function end() {
    const line = buffer.trim();
    buffer = "";
    if (line.startsWith("{")) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* idem */
      }
    }
    return state;
  }

  return { write, end, state };
}

/** Procura <promise>VALOR</promise> em todo o texto produzido pela iteração. */
export function foundPromise(state, promise) {
  const haystack = `${state.text}\n${state.finalResult ?? ""}`;
  return haystack.includes(`<promise>${promise}</promise>`);
}

export { C as colors, paint };
