// Host binding for injected credentials.
//
// A manifest names a credential (`auth`) and, for a github layer, also names
// where it would be sent (`apiBase`). Those two facts together are what makes a
// manifest you did not author dangerous: name a real alias, point apiBase at a
// host you control, and the token walks out. These tests pin the control that
// stops it — the secret is withheld unless the layer's target host matches the
// host the credential was minted for — and pin that the withholding is
// *reported* rather than silently swallowed, since a withheld token otherwise
// looks exactly like an empty repo.

import assert from "node:assert/strict";
import test from "node:test";

import { authTargetHost, resolveToken, resolveTokenState } from "../src/sources/index.mjs";
import { isLoopbackHost, validateApiBase } from "../src/manifest.mjs";

const gh = (extra = {}) => ({ name: "repo", source: "github", repo: "acme/payments", ...extra });
// Token- and userinfo-shaped strings are built at runtime so no credential-
// shaped literal is ever committed to a file.
const SECRET = "gh" + "u_" + "A".repeat(36);
const EVIL = "evil.example";
const USERINFO_SPOOF = "https://api.github.com" + "@" + EVIL;

test("a bound token reaches its own host", () => {
  const layer = gh({ auth: "keychain:github.com/octocat" });
  const tokens = { "github.com/octocat": { secret: SECRET, host: "api.github.com" } };
  assert.deepEqual(resolveTokenState(layer, tokens), {
    secret: SECRET,
    state: "ok",
    alias: "github.com/octocat",
  });
});

test("a bound token is withheld from a host it was not minted for", () => {
  // The exfiltration attempt: a valid alias, aimed elsewhere by the manifest.
  const layer = gh({ auth: "keychain:github.com/octocat", apiBase: `https://${EVIL}` });
  const tokens = { "github.com/octocat": { secret: SECRET, host: "api.github.com" } };
  const state = resolveTokenState(layer, tokens);
  assert.equal(state.secret, null, "the secret must not travel to an unbound host");
  assert.equal(state.state, "host-mismatch");
  assert.equal(state.alias, "github.com/octocat");
});

test("host binding compares the punycoded host, so an IDNA homograph does not match", () => {
  // "gıthub" (dotless i) is a different host and must not borrow the binding.
  const layer = gh({ auth: "keychain:gh", apiBase: "https://api.gıthub.com" });
  const tokens = { gh: { secret: SECRET, host: "api.github.com" } };
  assert.equal(resolveTokenState(layer, tokens).state, "host-mismatch");
});

test("userinfo in apiBase cannot spoof the bound host", () => {
  const layer = gh({ auth: "keychain:gh", apiBase: USERINFO_SPOOF });
  const tokens = { gh: { secret: SECRET, host: "api.github.com" } };
  assert.equal(authTargetHost(layer), EVIL, "the real host is the one after the @");
  assert.equal(resolveTokenState(layer, tokens).state, "host-mismatch");
});

test("an alias with no injected secret reads anonymously and says so", () => {
  const state = resolveTokenState(gh({ auth: "keychain:absent" }), {});
  assert.equal(state.secret, null);
  assert.equal(state.state, "missing-token");
});

test("a layer naming no credential is anonymous, not an error", () => {
  assert.deepEqual(resolveTokenState(gh()), { secret: null, state: "anonymous", alias: null });
});

test("a bare-string token entry stays unbound for legacy callers", () => {
  // buildSources' own callers (and the shell tests) inject plain strings; the
  // bound form is what the desktop broker sends.
  const layer = gh({ auth: "keychain:gh", apiBase: "https://ghe.internal" });
  assert.equal(resolveToken(layer, { gh: SECRET }), SECRET);
});

test("a tokenEnv secret defaults to github.com and is withheld elsewhere", () => {
  process.env.CC_TOKENS_TEST = SECRET;
  try {
    assert.equal(resolveTokenState(gh({ auth: { tokenEnv: "CC_TOKENS_TEST" } }), {}).state, "ok");
    const aimed = gh({ auth: { tokenEnv: "CC_TOKENS_TEST" }, apiBase: `https://${EVIL}` });
    assert.equal(resolveTokenState(aimed, {}).state, "host-mismatch");
  } finally {
    delete process.env.CC_TOKENS_TEST;
  }
});

test("CONTEXTCAKE_API_HOSTS is the documented escape hatch for GitHub Enterprise", () => {
  process.env.CC_TOKENS_TEST = SECRET;
  process.env.CONTEXTCAKE_API_HOSTS = "ghe.internal";
  try {
    const layer = gh({ auth: { tokenEnv: "CC_TOKENS_TEST" }, apiBase: "https://ghe.internal" });
    assert.equal(resolveTokenState(layer, {}).state, "ok");
  } finally {
    delete process.env.CC_TOKENS_TEST;
    delete process.env.CONTEXTCAKE_API_HOSTS;
  }
});

test("a malformed auth form is rejected rather than resolved", () => {
  const raw = "gh" + "p_" + "B".repeat(36);
  assert.throws(() => resolveTokenState(gh({ auth: raw }), {}), /never holds a credential|auth/i);
  assert.throws(() => resolveTokenState(gh({ auth: "keychain:" }), {}), /keychain/);
  assert.throws(() => resolveTokenState(gh({ auth: { token: "raw" } }), {}), /unrecognized/);
});

test("apiBase must be https, must not embed credentials, must not carry a query", () => {
  assert.throws(() => validateApiBase("http://api.github.com", "L"), /https/);
  assert.throws(() => validateApiBase(USERINFO_SPOOF.replace("//", "//user:pw@"), "L"), /credentials/);
  assert.throws(() => validateApiBase("https://api.github.com?to=evil", "L"), /query/);
  assert.throws(() => validateApiBase("not a url", "L"), /valid https URL/);
  validateApiBase("https://ghe.internal/api/v3", "L"); // the real GHES shape
  validateApiBase(undefined, "L"); // absent is the default, not an error
});

test("loopback over http is allowed so a mock API can prove the credentialed path", () => {
  validateApiBase("http://127.0.0.1:8080", "L");
  validateApiBase("http://localhost:3000", "L");
  assert.ok(isLoopbackHost("127.0.0.1:8080") && isLoopbackHost("[::1]:80") && isLoopbackHost("localhost"));
  assert.ok(!isLoopbackHost(EVIL), "a remote host is never loopback");
  // The near-miss that should not read as loopback.
  assert.ok(!isLoopbackHost(`127.0.0.1.${EVIL}`));
});
