import test from "node:test";
import assert from "node:assert/strict";
import { dockerHostAddress, translateLoopback } from "../src/paths.mjs";

test("translateLoopback: cada forma de loopback vira o endereço do Docker preservando porta e caminho", () => {
  for (const host of ["127.0.0.1", "localhost", "0.0.0.0"]) {
    assert.equal(
      translateLoopback(`http://${host}:11434/v1`),
      `http://${dockerHostAddress()}:11434/v1`
    );
  }
  assert.equal(
    translateLoopback("http://[::1]:11434/v1"),
    `http://${dockerHostAddress()}:11434/v1`
  );
});

test("translateLoopback: host que não é loopback volta intacto", () => {
  assert.equal(translateLoopback("https://api.openai.com/v1"), "https://api.openai.com/v1");
});

test("translateLoopback: URL que não parseia volta como veio, sem lançar", () => {
  assert.equal(translateLoopback("nao-e-url"), "nao-e-url");
  assert.equal(translateLoopback(""), "");
});
