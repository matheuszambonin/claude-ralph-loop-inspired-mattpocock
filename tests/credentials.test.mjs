import test from "node:test";
import assert from "node:assert/strict";
import { parse, verdict, isAuthFailure } from "../src/credentials.mjs";

const HOUR = 3600_000;
const NOW = 1_787_000_000_000;

function creds({ expiresAt, refreshTokenExpiresAt } = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-x",
      refreshToken: "sk-ant-ort01-x",
      expiresAt: expiresAt ?? NOW + 8 * HOUR,
      ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
    },
  });
}

test("parse: arquivo ausente ou vazio devolve null", () => {
  assert.equal(parse(""), null);
  assert.equal(parse("   \n"), null);
  assert.equal(parse(null), null);
});

test("parse: JSON quebrado devolve null", () => {
  assert.equal(parse("{ nao é json"), null);
});

test("parse: JSON válido sem o bloco de OAuth devolve null", () => {
  assert.equal(parse(JSON.stringify({ outra: "coisa" })), null);
});

test("parse: extrai as duas expirações", () => {
  const got = parse(creds({ expiresAt: 10, refreshTokenExpiresAt: 20 }));
  assert.deepEqual(got, { expiresAt: 10, refreshTokenExpiresAt: 20 });
});

test("parse: credencial sem refreshTokenExpiresAt não inventa valor", () => {
  assert.equal(parse(creds({ expiresAt: 10 })).refreshTokenExpiresAt, null);
});

test("verdict: token válido passa", () => {
  const v = verdict({ sandbox: parse(creds()), now: NOW });
  assert.equal(v.ok, true);
  assert.match(v.message, /autenticado/);
});

test("verdict: sandbox sem credencial manda rodar ralph login", () => {
  const v = verdict({ sandbox: null, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.message, /ralph login/);
});

test("verdict: refresh vencido manda relogar, não recopiar", () => {
  const sandbox = parse(creds({ expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW - HOUR }));
  const v = verdict({ sandbox, host: parse(creds()), now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.message, /'ralph login'/);
  assert.doesNotMatch(v.message, /--share-credentials/);
});

test("verdict: token vencido e host mais novo manda recopiar do host", () => {
  const sandbox = parse(creds({ expiresAt: NOW - 15 * HOUR, refreshTokenExpiresAt: NOW + 100 * HOUR }));
  const host = parse(creds({ expiresAt: NOW + 8 * HOUR }));
  const v = verdict({ sandbox, host, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.message, /ralph login --share-credentials/);
  assert.match(v.message, /15h/);
});

test("verdict: token vencido sem host para comparar ainda reprova", () => {
  const sandbox = parse(creds({ expiresAt: NOW - HOUR }));
  assert.equal(verdict({ sandbox, now: NOW }).ok, false);
});

test("verdict: host mais velho que o sandbox não acusa cópia velha", () => {
  const sandbox = parse(creds({ expiresAt: NOW - HOUR }));
  const host = parse(creds({ expiresAt: NOW - 5 * HOUR }));
  assert.doesNotMatch(verdict({ sandbox, host, now: NOW }).message, /host tem um mais novo/);
});

test("isAuthFailure: reconhece o resultado que matou a iteração", () => {
  const state = { finalResult: "Failed to authenticate: OAuth session expired and could not be refreshed" };
  assert.equal(isAuthFailure(state), true);
});

test("isAuthFailure: iteração normal não dispara", () => {
  assert.equal(isAuthFailure({ finalResult: "COMPLETE — backlog vazio" }), false);
  assert.equal(isAuthFailure({}), false);
});
