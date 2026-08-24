import test from "node:test";
import assert from "node:assert/strict";
import { createStreamRenderer } from "../src/stream.mjs";

function feed(renderer, evt) {
  renderer.write(JSON.stringify(evt) + "\n");
}

test("createStreamRenderer: guarda mcp_servers do evento init, como já guarda skills", () => {
  const renderer = createStreamRenderer();
  feed(renderer, {
    type: "system",
    subtype: "init",
    session_id: "abc123",
    model: "sonnet",
    tools: [],
    skills: ["mattpocock-skills:implement"],
    mcp_servers: [{ name: "code-review-graph", status: "failed" }],
  });
  const state = renderer.end();
  assert.deepEqual(state.mcpServers, [{ name: "code-review-graph", status: "failed" }]);
});

test("createStreamRenderer: init sem mcp_servers deixa o estado null", () => {
  const renderer = createStreamRenderer();
  feed(renderer, { type: "system", subtype: "init", session_id: "abc123", model: "sonnet", tools: [] });
  const state = renderer.end();
  assert.equal(state.mcpServers, null);
});
