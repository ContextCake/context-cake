// Credentials on the git clone/pull path.
//
// The failure this file exists to prevent is not "the clone didn't work" — it
// is a token quietly ending up somewhere we don't control. Git's credential
// helper chain is cumulative and normally terminates at the OS keychain, so
// naively handing git a token makes git PERSIST it: a copy outside our store,
// surviving uninstall, invisible to the app's own disconnect button. So the
// chain reset is asserted directly, against the real git binary, rather than
// trusted to a comment.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createEngineService } from "../src/service.mjs";

const execFileP = promisify(execFile);
const SECRET = "gh" + "u_" + "C".repeat(36);
const SECOND_SECRET = "gh" + "u_" + "D".repeat(36);

// A stand-in for git that records exactly how it was invoked, then fakes a
// successful clone (or a private-repo rejection).
const SHIM = `#!/bin/sh
{
  for a in "$@"; do echo "ARG:$a"; done
  echo "ENV_CC_GIT_TOKEN:\${CC_GIT_TOKEN:-<unset>}"
  echo "ENV_GIT_TERMINAL_PROMPT:\${GIT_TERMINAL_PROMPT:-<unset>}"
  echo "ENV_GIT_CONFIG_NOSYSTEM:\${GIT_CONFIG_NOSYSTEM:-<unset>}"
  echo "ENV_GIT_TRACE:\${GIT_TRACE:-<unset>}"
  echo "INVOCATION_END"
} >> "$CC_TEST_LOG"

for last; do :; done
if [ "$CC_TEST_FAIL" = "1" ] || { [ -n "$CC_TEST_REJECT_TOKEN" ] && [ "$CC_GIT_TOKEN" = "$CC_TEST_REJECT_TOKEN" ]; }; then
  mkdir -p "$last/partial"
  echo "fatal: Authentication failed for 'https://github.com/acme/private.git/'" >&2
  exit 128
fi

mkdir -p "$last/.git"
printf -- '---\\ntype: note\\ntitle: Cloned\\n---\\n\\n# Cloned\\n\\n## S {#s}\\n\\nbody.\\n' > "$last/note.md"
exit 0
`;

async function withService(run, { tokens, fail = false, rejectToken = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gitauth-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "git"), SHIM, { mode: 0o755 });

  const log = path.join(dir, "git.log");
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ layers: [] }));

  const saved = { PATH: process.env.PATH, TRACE: process.env.GIT_TRACE };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.CC_TEST_LOG = log;
  // Already set in the user's shell is the realistic case: it must not survive
  // into a credentialed git invocation.
  process.env.GIT_TRACE = "1";
  if (fail) process.env.CC_TEST_FAIL = "1";
  if (rejectToken) process.env.CC_TEST_REJECT_TOKEN = rejectToken;

  const svc = createEngineService({ manifestPath, tokens });
  const server = http.createServer(async (req, res) => {
    if (await svc.handleRequest(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run({ base, dir, readLog: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") });
  } finally {
    svc.close(); server.close();
    process.env.PATH = saved.PATH;
    if (saved.TRACE === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = saved.TRACE;
    delete process.env.CC_TEST_LOG;
    delete process.env.CC_TEST_FAIL;
    delete process.env.CC_TEST_REJECT_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const addSource = (base, body) => fetch(`${base}/api/sources`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: base },
  body: JSON.stringify(body),
});

const tokensFor = (gitHost) => ({
  "github.com/octocat": { secret: SECRET, host: "api.github.com", gitHost },
});

test("a connected credential is offered to a matching host, and never through argv", async () => {
  await withService(async ({ base, readLog }) => {
    const res = await addSource(base, { kind: "github", name: "priv", level: 2, repo: "acme/private" });
    assert.equal(res.status, 200, await res.text());

    const logText = readLog();
    const args = logText.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));

    // The chain reset: an empty value clears every inherited helper, so the
    // OS keychain is not in the list and git has nowhere to persist anything.
    const resetAt = args.indexOf("credential.helper=");
    assert.ok(resetAt > 0, `expected a credential.helper reset, got ${JSON.stringify(args)}`);
    assert.equal(args[resetAt - 1], "-c");

    // ...followed by our one-shot helper, which stores nothing.
    const helper = args.find((a) => a.startsWith("credential.helper=!"));
    assert.ok(helper, "expected a one-shot credential helper");
    assert.match(helper, /x-access-token/);
    assert.ok(args.indexOf(helper) > resetAt, "the one-shot must come after the reset");

    // The secret rides the environment; the argv is world-readable via ps.
    assert.match(logText, new RegExp(`ENV_CC_GIT_TOKEN:${SECRET}`));
    for (const a of args) assert.ok(!a.includes(SECRET), `secret leaked into argv: ${a}`);

    assert.match(logText, /ENV_GIT_TERMINAL_PROMPT:0/);
    assert.match(logText, /ENV_GIT_CONFIG_NOSYSTEM:1/);
    // A tracing variable already in the shell would dump the credential exchange.
    assert.match(logText, /ENV_GIT_TRACE:<unset>/);
  }, { tokens: tokensFor("github.com") });
});

test("a credential for another host is never offered to this remote", async () => {
  await withService(async ({ base, readLog }) => {
    const res = await addSource(base, { kind: "github", name: "priv", level: 2, repo: "acme/private" });
    assert.equal(res.status, 200, await res.text());
    const logText = readLog();
    // Connected for ghe.acme.com, cloning github.com: no credential at all.
    assert.match(logText, /ENV_CC_GIT_TOKEN:<unset>/);
    assert.ok(!logText.includes("credential.helper="), "no helper should be configured without a credential");
    // The hardening that does not depend on having a secret still applies.
    assert.match(logText, /ENV_GIT_TERMINAL_PROMPT:0/);
  }, { tokens: tokensFor("ghe.acme.com") });
});

test("a second account on the same host is tried after the first lacks access", async () => {
  const tokens = {
    "github.com/first": { secret: SECRET, host: "api.github.com", gitHost: "github.com" },
    "github.com/second": { secret: SECOND_SECRET, host: "api.github.com", gitHost: "github.com" },
  };
  await withService(async ({ base, readLog }) => {
    const res = await addSource(base, { kind: "github", name: "priv", level: 2, repo: "acme/private" });
    assert.equal(res.status, 200, await res.text());
    const logText = readLog();
    assert.match(logText, new RegExp(`ENV_CC_GIT_TOKEN:${SECRET}`));
    assert.match(logText, new RegExp(`ENV_CC_GIT_TOKEN:${SECOND_SECRET}`));
    assert.equal((logText.match(/INVOCATION_END/g) ?? []).length, 2, "git should retry exactly once with the second account");
  }, { tokens, rejectToken: SECRET });
});

test("an auth failure is reported as needing a connection, not as raw git noise", async () => {
  await withService(async ({ base, dir }) => {
    const res = await addSource(base, { kind: "github", name: "priv", level: 2, repo: "acme/private" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.needsAuth, true);
    assert.match(body.hint, /Connect a GitHub account/);
    assert.equal(
      fs.existsSync(path.join(dir, ".cache", "repos", "github.com__acme__private")),
      false,
      "a failed clone must not poison the next retry with a partial cache directory",
    );
  }, { tokens: {}, fail: true });
});

test("a failure with a credential attached blames access, and never quotes the token", async () => {
  await withService(async ({ base }) => {
    const res = await addSource(base, { kind: "github", name: "priv", level: 2, repo: "acme/private" });
    assert.equal(res.status, 502);
    const raw = JSON.stringify(await res.json());
    assert.match(raw, /None of the connected GitHub accounts can access this repository/);
    assert.ok(!raw.includes(SECRET), "an error body must never carry the credential");
  }, { tokens: tokensFor("github.com"), fail: true });
});

// The two assertions above rest on how the REAL git treats an empty
// credential.helper value. That is a behavior of the installed binary, not of
// our code, so it is verified against it directly.
test("real git: the reset lands after every inherited helper", async (t) => {
  let gitOk = true;
  try { await execFileP("git", ["--version"]); } catch { gitOk = false; }
  if (!gitOk) return t.skip("git is not installed");

  // NUL-delimited: an empty value is a real entry in this list, and splitting
  // on newlines would silently discard the very thing being asserted.
  const { stdout } = await execFileP("git", [
    "-c", "credential.helper=osxkeychain",   // stand-in for whatever the user has
    "-c", "credential.helper=",              // the reset
    "-c", "credential.helper=!f",            // our one-shot
    "config", "--get-all", "--null", "credential.helper",
  ]);
  const chain = stdout.split("\0").slice(0, -1);
  // Order is what matters: everything inherited sits BEFORE the empty entry,
  // so nothing but our one-shot survives it. The user's real global config is
  // in here too, which is the point — this asserts against their machine.
  assert.deepEqual(chain.slice(-2), ["", "!f"]);
  assert.ok(!chain.slice(chain.indexOf("") + 1).includes("osxkeychain"), "no persisting helper may follow the reset");
});

test("real git: only the one-shot answers, so nothing is written to a keychain", async (t) => {
  let gitOk = true;
  try { await execFileP("git", ["--version"]); } catch { gitOk = false; }
  if (!gitOk) return t.skip("git is not installed");

  // The behavioral proof: ask git's own credential machinery what it resolves
  // to, with an inherited persisting helper in front of the reset.
  // execFileSync, not execFile: `credential fill` reads its request from stdin
  // and only the *Sync* form accepts `input`. The async form leaves stdin open
  // and git waits forever.
  const stdout = execFileSync("git", [
    "-c", "credential.helper=osxkeychain",
    "-c", "credential.helper=",
    "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$CC_GIT_TOKEN"; }; f',
    "credential", "fill",
  ], {
    input: "protocol=https\nhost=contextcake.invalid\n",
    env: { ...process.env, CC_GIT_TOKEN: SECRET, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.match(stdout, /username=x-access-token/);
  assert.match(stdout, new RegExp(`password=${SECRET}`));
});

test("real git: the one-shot helper yields the expected credential", async (t) => {
  let shOk = true;
  try { await execFileP("sh", ["-c", "true"]); } catch { shOk = false; }
  if (!shOk) return t.skip("no POSIX shell");

  // Exactly the helper body git would run (git strips the leading '!').
  const body = 'f() { echo username=x-access-token; echo "password=$CC_GIT_TOKEN"; }; f get';
  const { stdout } = await execFileP("sh", ["-c", body], { env: { ...process.env, CC_GIT_TOKEN: SECRET } });
  assert.equal(stdout.trim(), `username=x-access-token\npassword=${SECRET}`);
});
