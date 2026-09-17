// The `contextcake` contract (control-plane spec §5.1, §5.2; design §3, §10):
// help generated from the routing table, the envelope, the exit-code table,
// redaction, the mcp flag guard, --timeout, coverage, and interrupts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { TABLE } from "../src/cli.mjs";
import { parseCommandArgs, parseTimeout } from "../src/cli/args.mjs";
import { manifestRevisionOf } from "../src/cli/context.mjs";
import { guardMcpArgs, prepareSpawnArgs } from "../src/cli/spawn.mjs";
import { buildTable, defineFamily, resolveCommand } from "../src/cli/table.mjs";
import {
  CODE_CATEGORIES,
  ControlError,
  EXIT_CATEGORIES,
  exitCodeFor,
  manifestControlError,
  toControlError,
} from "../src/control/errors.mjs";
import { REDACTED, createRedactor } from "../src/control/redact.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

// Token-shaped strings are assembled at runtime so no literal in this file
// looks like a real credential to a secret scanner.
const shaped = (...parts) => parts.join("");
const GITHUB_TOKEN = shaped("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3");
const GITHUB_PAT = shaped("github", "_pat_", "11ABCDEFG0123456789", "_abcdefghijk");
const OPENAI_KEY = shaped("sk", "-proj-", "abcdefghijklmnop1234");
const AWS_KEY = shaped("AK", "IA", "IOSFODNN7EXAMPLE");
const URL_PASSWORD = shaped("hunter2", "hunter2");
const URL_WITH_USERINFO = shaped("https://user:", URL_PASSWORD, "@", "example.com/org/repo.git");

function testTable(...families) {
  return buildTable(families);
}

test("exit categories are the §5.2 table", () => {
  assert.deepEqual({ ...EXIT_CATEGORIES }, {
    ok: 0,
    internal: 1,
    "invalid-input": 2,
    "not-found": 3,
    conflict: 4,
    permission: 5,
    unavailable: 6,
    integrity: 7,
    unhealthy: 8,
    interrupted: 130,
  });
  for (const [code, category] of Object.entries(CODE_CATEGORIES)) {
    assert.ok(Object.hasOwn(EXIT_CATEGORIES, category), `${code} maps to unknown category ${category}`);
  }
});

test("errors map to exit codes by explicit category, then code, then status", () => {
  const cases = [
    [new ControlError("INVALID_INPUT", "x", { status: 400 }), 2],
    [new ControlError("SOURCE_NOT_FOUND", "x", { status: 404 }), 3],
    [new ControlError("STALE_REVISION", "x", { status: 409 }), 4],
    [new ControlError("CONFIRMATION_REQUIRED", "x", { status: 409 }), 4],
    [new ControlError("UNTRUSTED_SOURCE", "x", { status: 403 }), 5],
    [new ControlError("CREDENTIAL_BACKEND_UNAVAILABLE", "x", { status: 503 }), 5],
    [new ControlError("TIMEOUT", "x", { status: 504 }), 6],
    [new ControlError("MANIFEST_LOCKED", "x", { status: 503 }), 6],
    [new ControlError("RECOVERY_REQUIRED", "x", { status: 409 }), 7],
    [new ControlError("UNHEALTHY_DIAGNOSTICS", "x"), 8],
    [new ControlError("INTERRUPTED", "x"), 130],
    // Unlisted codes fall back to their HTTP status.
    [new ControlError("SOME_NEW_CODE", "x", { status: 400 }), 2],
    [new ControlError("SOME_NEW_CODE", "x", { status: 404 }), 3],
    [new ControlError("SOME_NEW_CODE", "x", { status: 409 }), 4],
    [new ControlError("SOME_NEW_CODE", "x", { status: 403 }), 5],
    [new ControlError("SOME_NEW_CODE", "x", { status: 502 }), 6],
    [new ControlError("SOME_NEW_CODE", "x", { status: 500 }), 1],
    // An explicit category beats both.
    [new ControlError("STALE_REVISION", "x", { status: 409, exit: "integrity" }), 7],
    // Plain errors.
    [toControlError(Object.assign(new Error("gone"), { code: "ENOENT" })), 3],
    [toControlError(Object.assign(new Error("no"), { code: "EACCES" })), 5],
    [toControlError(Object.assign(new Error("slow"), { code: "CONTEXTCAKE_TIMEOUT" })), 6],
    [toControlError(new Error("boom")), 1],
    [manifestControlError(new Error("ContextCake manifest does not exist: /x")), 3],
    [manifestControlError(new Error("ContextCake manifest is not valid JSON: y")), 7],
    [manifestControlError(new Error("Timed out acquiring the ContextCake manifest lock at /x.lock.")), 6],
    [manifestControlError(new Error("Unknown ContextCake profile: work")), 3],
    [manifestControlError(new Error("Profile work requires migration to Manifest v2.")), 4],
  ];
  for (const [error, exit] of cases) assert.equal(exitCodeFor(error), exit, `${error.code}: ${error.message}`);
});

test("help --json is generated from the table that routes", async (t) => {
  const home = await cliHome(t);
  const result = await runContextcake(["help", "--json"], home);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const help = result.json.data;
  const tableIds = [...TABLE.byId.keys()].sort();
  assert.deepEqual(help.commands.map((command) => command.id).sort(), tableIds);
  assert.deepEqual(help.exitCodes.map((row) => row.code), Object.values(EXIT_CATEGORIES));
  for (const described of help.commands) {
    // Every documented id routes to exactly the command it documents.
    const routed = resolveCommand(TABLE, described.id.split("."));
    assert.equal(routed.command?.id, described.id);
    assert.ok(["stable", "experimental"].includes(described.stability));
    assert.ok(["read", "write", "destructive", "serve"].includes(described.mutation));
    for (const key of ["usage", "inputs", "preconditions", "errors", "output", "coverage"]) assert.ok(Object.hasOwn(described, key), `${described.id} lacks ${key}`);
    for (const error of described.errors) assert.equal(typeof error.exitCode, "number", `${described.id} ${error.code}`);
    if (described.output === "envelope") {
      assert.ok(described.dataSchema, `${described.id} needs an output schema`);
      assert.ok(described.errors.some((error) => error.code === "INVALID_INPUT"));
    }
  }
  for (const family of help.families) {
    assert.ok(family.commands.every((id) => TABLE.byId.get(id).family === family.name));
  }
  const byId = Object.fromEntries(help.commands.map((command) => [command.id, command]));
  assert.equal(byId["account.status"].stability, "stable");
  assert.equal(byId.mcp.output, "passthrough");
  assert.equal(byId["profile.delete"].timeout, "refused");
  assert.ok(byId["profile.delete"].inputs.flags.some((flag) => flag.name === "--expect-revision"));
  assert.ok(!byId["profile.list"].inputs.flags.some((flag) => flag.name === "--expect-revision"));

  const filtered = await runContextcake(["help", "profile", "--json"], home);
  assert.ok(filtered.json.data.commands.length > 0);
  assert.ok(filtered.json.data.commands.every((command) => command.family === "profile"));
});

test("the table refuses commands that break the contract", () => {
  const base = { name: "x", stability: "experimental", summary: "x" };
  const command = { summary: "x", mutation: "read", run: () => ({ data: null }) };
  assert.throws(() => defineFamily({ ...base, stability: "beta", commands: [command] }), /stability/);
  assert.throws(() => defineFamily({ ...base, commands: [{ ...command, mutation: "write", coverage: true }] }), /coverage/);
  assert.throws(() => defineFamily({ ...base, commands: [{ ...command, errors: ["NOT_A_REAL_CODE"] }] }), /no exit category/);
  assert.throws(() => defineFamily({ ...base, commands: [{ ...command, flags: { json: { type: "boolean" } } }] }), /global flag/);
  assert.throws(() => defineFamily({ ...base, commands: [{ ...command, run: undefined }] }), /exactly one of run or spawn/);
  assert.throws(() => buildTable([defineFamily({ ...base, commands: [command] }), defineFamily({ ...base, commands: [command] })]), /registered twice/);
});

test("argument parsing is strict and typed", () => {
  const family = defineFamily({
    name: "demo",
    stability: "experimental",
    summary: "demo",
    commands: [{
      name: "run",
      summary: "demo",
      mutation: "write",
      manifest: "required",
      preconditions: ["manifest-revision"],
      positionals: [{ name: "id", required: true }, { name: "rest", variadic: true }],
      flags: { level: { type: "integer" }, tag: { type: "string", repeatable: true }, force: { type: "boolean" } },
      run: () => ({ data: null }),
    }],
  });
  const [command] = family.commands;
  const parsed = parseCommandArgs(command, ["a", "b", "c", "--level=-3", "--tag", "x", "--tag", "y", "--force", "--expect-revision", "sha256:1"]);
  assert.deepEqual(parsed.args, { id: "a", rest: ["b", "c"] });
  assert.deepEqual(parsed.flags, { level: -3, tag: ["x", "y"], force: true, expectRevision: "sha256:1" });
  assert.deepEqual(parseCommandArgs(command, ["--", "--not-a-flag"]).args, { id: "--not-a-flag", rest: [] });
  for (const [argv, message] of [
    [[], /<id> is required/],
    [["a", "--nope"], /Unknown option --nope/],
    [["a", "--level", "high"], /must be an integer/],
    [["a", "--level"], /requires a value/],
    [["a", "--force=yes"], /does not take a value/],
    [["a", "--profile", "x"], /Unknown option --profile/],
    [["a", "--require-complete"], /Unknown option --require-complete/],
  ]) {
    assert.throws(() => parseCommandArgs(command, argv), (error) => error.code === "INVALID_INPUT" && message.test(error.message));
  }
  assert.equal(parseTimeout("1500"), 1500);
  assert.equal(parseTimeout("30s"), 30_000);
  assert.equal(parseTimeout("2m"), 120_000);
  assert.throws(() => parseTimeout("soon"), /duration/);
});

test("a failure is one envelope with a typed error, and human mode writes stderr", async (t) => {
  const home = await cliHome(t);
  const json = await runContextcake(["profile", "list", "--json"], home);
  assert.equal(json.exitCode, 3);
  assert.equal(json.json.ok, false);
  assert.equal(json.json.command, "profile.list");
  assert.equal(json.json.error.code, "MANIFEST_NOT_FOUND");
  assert.equal(json.json.error.category, "not-found");
  assert.deepEqual(Object.keys(json.json), ["schemaVersion", "ok", "command", "context", "data", "error", "warnings", "nextActions"]);
  assert.deepEqual(Object.keys(json.json.context), ["manifestPath", "manifestRevision", "profileId", "profileReason"]);
  assert.equal(json.stderr, "");

  const human = await runContextcake(["profile", "list"], home);
  assert.equal(human.exitCode, 3);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /No manifest at .*contextcake init/);

  const badFlag = await runContextcake(["profile", "list", "--bogus", "--json"], home);
  assert.equal(badFlag.exitCode, 2);
  assert.equal(badFlag.json.error.code, "INVALID_INPUT");

  const unknown = await runContextcake(["no-such-family", "--json"], home);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.json.error.code, "UNKNOWN_COMMAND");
  const unknownSub = await runContextcake(["profile", "no-such-command", "--json"], home);
  assert.equal(unknownSub.exitCode, 2);
});

test("manifestRevision hashes stableJson, so key order never changes it", async (t) => {
  const a = { profiles: { default: { label: "Default", layers: [] } }, projects: {} };
  const b = { projects: {}, profiles: { default: { layers: [], label: "Default" } } };
  assert.equal(manifestRevisionOf(a), manifestRevisionOf(b));
  assert.match(manifestRevisionOf(a), /^sha256:[a-f0-9]{64}$/);

  const home = await cliHome(t);
  await writeManifest(home, b);
  const result = await runContextcake(["profile", "list", "--json"], home);
  assert.equal(result.json.context.manifestRevision, manifestRevisionOf(a));
});

test("account status reports a typed disabled state and exits 0", async (t) => {
  const home = await cliHome(t);
  const json = await runContextcake(["account", "status", "--json"], home);
  assert.equal(json.exitCode, 0);
  assert.equal(json.json.data.state, "disabled");
  assert.equal(json.json.data.reason, "disabled-in-build");
  assert.ok(!Object.hasOwn(json.json, "coverage"));
  const human = await runContextcake(["account", "status"], home);
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /disabled in this build/);
});

test("mcp accepts only its serving flags and never writes an error to stdout", async (t) => {
  guardMcpArgs(["--manifest", "/m.json", "--profile", "work", "--capture", "--telemetry", "--harness", "claude-code"]);
  guardMcpArgs(["--personal", "/a", "--shared", "/b"]);
  guardMcpArgs(["--help"]);
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  for (const argv of [["--json"], ["--quiet"], ["--timeout", "5"], ["--timeout=5"], ["--no-input"], ["--manifest"], ["stray"]]) {
    let spawned = false;
    const result = await runContextcake(["mcp", ...argv], home, { wrapSpawn: () => { spawned = true; return { args: ["-e", ""], env: {} }; } });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "", "stdout is the MCP channel");
    assert.match(result.stderr, /mcp/);
    assert.equal(spawned, false);
  }
});

test("spawned commands get the default manifest injected and the wrapSpawn hook", async (t) => {
  const home = await cliHome(t);
  const missing = await runContextcake(["resolve", "--concept", "x"], home);
  assert.equal(missing.exitCode, 3);
  assert.match(missing.stderr, /No manifest at .*contextcake init/);

  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  const calls = [];
  const result = await runContextcake(["mcp", "--capture"], home, {
    wrapSpawn: (call) => {
      calls.push(call);
      return { args: ["-e", "process.exit(7)"], env: call.env };
    },
  });
  assert.equal(result.exitCode, 7, "the child's exit status is forwarded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "mcp");
  assert.match(calls[0].entry, /mcp-server\.mjs$/);
  assert.deepEqual(calls[0].args, ["--manifest", home.manifestPath, "--capture"]);
  assert.equal(calls[0].paths.config, home.config);

  const pack = TABLE.byId.get("pack");
  assert.deepEqual(prepareSpawnArgs(pack, ["list"], { manifestPath: home.manifestPath }), ["list", "--manifest", home.manifestPath]);
  assert.deepEqual(prepareSpawnArgs(pack, ["inspect", "/dir"], { manifestPath: home.manifestPath }), ["inspect", "/dir"]);
  const doctor = TABLE.byId.get("doctor");
  assert.deepEqual(prepareSpawnArgs(doctor, ["--json"], { manifestPath: "/nowhere/manifest.json" }), ["--manifest", "/nowhere/manifest.json", "--json"]);
  const resolve = TABLE.byId.get("resolve");
  assert.deepEqual(prepareSpawnArgs(resolve, ["--personal", "/a", "--shared", "/b"], { manifestPath: "/nowhere" }), ["--personal", "/a", "--shared", "/b"]);
  assert.deepEqual(prepareSpawnArgs(resolve, ["--help"], { manifestPath: "/nowhere" }), ["--help"]);
});

test("--timeout is refused on writes and enforced on reads", async (t) => {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  const refused = await runContextcake(["profile", "rename", "default", "X", "--timeout", "5s", "--json"], home);
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.json.error.code, "TIMEOUT_REFUSED");

  let wrote = false;
  const slow = defineFamily({
    name: "slow",
    stability: "experimental",
    summary: "slow",
    commands: [
      { name: "read", summary: "slow", mutation: "read", output: { type: "null" }, run: () => new Promise(() => {}) },
      { name: "write", summary: "write", mutation: "write", run: () => { wrote = true; return { data: null }; } },
    ],
  });
  const refusedBeforeRunning = await runContextcake(["slow", "write", "--timeout", "1s", "--json"], home, { table: testTable(slow) });
  assert.equal(refusedBeforeRunning.exitCode, 2);
  assert.equal(wrote, false, "a refused --timeout never starts the mutation");
  const timedOut = await runContextcake(["slow", "read", "--timeout", "20", "--json"], home, { table: testTable(slow) });
  assert.equal(timedOut.exitCode, 6);
  assert.equal(timedOut.json.error.code, "TIMEOUT");
  assert.equal(timedOut.json.error.retryable, true);
});

test("coverage appears only on read commands that declare it, and --require-complete exits 6", async (t) => {
  const home = await cliHome(t);
  const coverage = { complete: false, degraded: [{ source: "remote", reason: "timeout" }] };
  const family = defineFamily({
    name: "query",
    stability: "experimental",
    summary: "query",
    commands: [{ name: "all", summary: "all", mutation: "read", coverage: true, output: { type: "array" }, run: () => ({ data: [], coverage }) }],
  });
  const table = testTable(family);
  const partial = await runContextcake(["query", "all", "--json"], home, { table });
  assert.equal(partial.exitCode, 0);
  assert.deepEqual(partial.json.coverage, coverage);
  const strict = await runContextcake(["query", "all", "--require-complete", "--json"], home, { table });
  assert.equal(strict.exitCode, 6);
  assert.equal(strict.json.error.code, "INCOMPLETE_COVERAGE");
  assert.deepEqual(strict.json.error.details, coverage);
});

test("nextActions never name a command this build does not have", async (t) => {
  const home = await cliHome(t);
  const family = defineFamily({
    name: "hint",
    stability: "experimental",
    summary: "hint",
    commands: [{
      name: "me",
      summary: "hint",
      mutation: "read",
      run(ctx) {
        ctx.suggest("hint.me", "contextcake hint me");
        ctx.suggest("absent.family", "contextcake absent family");
        return { data: null };
      },
    }],
  });
  const result = await runContextcake(["hint", "me", "--json"], home, { table: testTable(family) });
  assert.deepEqual(result.json.nextActions.map((action) => action.command), ["hint.me"]);
});


test("redaction covers credential values, provider token shapes, and Authorization headers", () => {
  const { redact, redactString } = createRedactor(["plain-looking-secret-value"]);
  const cases = [
    ["value plain-looking-secret-value leaked", "plain-looking-secret-value"],
    [`token ${GITHUB_TOKEN} leaked`, GITHUB_TOKEN],
    [`pat ${GITHUB_PAT} leaked`, GITHUB_PAT.slice(0, 20)],
    [`key ${OPENAI_KEY} leaked`, OPENAI_KEY.slice(-12)],
    [`aws ${AWS_KEY} leaked`, AWS_KEY],
    ["header Authorization: Bearer abc.def.ghi-jkl", "abc.def.ghi-jkl"],
    ['{"authorization":"token zzzzzzzzzzzz"}', "zzzzzzzzzzzz"],
    ["just Bearer qwertyuiopasdf", "qwertyuiopasdf"],
    [`remote ${URL_WITH_USERINFO}`, URL_PASSWORD],
  ];
  for (const [input, secret] of cases) {
    const output = redactString(input);
    assert.ok(!output.includes(secret), `${input} -> ${output}`);
    assert.ok(output.includes(REDACTED), output);
  }
  const tree = redact({ token: "not-shaped-at-all", nested: [{ password: "p4ss" }], [GITHUB_TOKEN]: 1, safe: "a normal message" });
  assert.equal(tree.token, REDACTED);
  assert.equal(tree.nested[0].password, REDACTED);
  assert.ok(!JSON.stringify(tree).includes(GITHUB_TOKEN));
  assert.equal(tree.safe, "a normal message");
  // Linear on hostile input: long runs that almost match return quickly.
  const started = Date.now();
  redactString(`${"a.".repeat(50_000)}://${"b".repeat(50_000)}`);
  redactString(`Authorization${" ".repeat(50_000)}`);
  redactString(`sk-${"-".repeat(100_000)}`);
  assert.ok(Date.now() - started < 1000);
});

test("hostile secret-shaped errors never reach stdout or stderr", async (t) => {
  const home = await cliHome(t);
  const envSecret = "env-provided-secret-9f8e7d";
  const mapSecret = "injected-token-map-value";
  const logToken = shaped("gh", "p_", "LOGLOGLOGLOGLOGLOGLOG12");
  const messageToken = shaped("gh", "p_", "MSGMSGMSGMSGMSGMSGMSG12");
  const keyToken = shaped("gh", "p_", "DETAILKEYDETAILKEY1234");
  const detailUrl = shaped("https://x:", "injected-secret-pw", "@", "example.com/");
  await writeManifest(home, {
    profiles: {
      default: {
        label: "Default",
        layers: [{ name: "gh", source: "github", repo: "o/r", level: 1, auth: { tokenEnv: "CC_TEST_TOKEN" } }],
      },
    },
  });
  const hostile = defineFamily({
    name: "hostile",
    stability: "experimental",
    summary: "hostile",
    commands: [{
      name: "fail",
      summary: "hostile",
      mutation: "read",
      manifest: "required",
      errors: ["UPSTREAM_FAILED"],
      errorCategories: { UPSTREAM_FAILED: "unavailable" },
      run(ctx) {
        ctx.readManifest();
        ctx.log(`log line with ${envSecret} and ${logToken}`);
        const wrapped = new Error(`fetch failed: Authorization: Bearer abcdefghijklmnop ${envSecret} ${mapSecret}`);
        throw new ControlError("UPSTREAM_FAILED", `wrapped: ${wrapped.message} ${messageToken}`, {
          status: 502,
          detail: { url: detailUrl, headers: { authorization: "Bearer zzzzzzzzzzzzzz" }, echo: envSecret, [keyToken]: true },
        });
      },
    }],
  });
  const table = testTable(hostile);
  const leaks = [envSecret, mapSecret, logToken, "abcdefghijklmnop", messageToken, "injected-secret-pw", "zzzzzzzzzzzzzz", keyToken];
  for (const argv of [["hostile", "fail", "--json"], ["hostile", "fail"]]) {
    const result = await runContextcake(argv, home, { table, env: { CC_TEST_TOKEN: envSecret }, secrets: [mapSecret] });
    assert.equal(result.exitCode, 6);
    assert.ok(result.stdout.length + result.stderr.length > 0);
    for (const leak of leaks) {
      assert.ok(!result.stdout.includes(leak), `stdout leaked ${leak}: ${result.stdout}`);
      assert.ok(!result.stderr.includes(leak), `stderr leaked ${leak}: ${result.stderr}`);
    }
  }
});

test("human output prints the text and warnings go to stderr unless --quiet", async (t) => {
  const home = await cliHome(t);
  await fs.mkdir(home.config, { recursive: true });
  await fs.writeFile(home.manifestPath, JSON.stringify({ layers: [] }));
  const loud = await runContextcake(["init"], home);
  assert.equal(loud.exitCode, 0);
  assert.match(loud.stdout, /legacy manifest already exists/);
  assert.match(loud.stderr, /warning: .*never migrates/);
  const quiet = await runContextcake(["init", "--quiet"], home);
  assert.equal(quiet.stderr, "");
});

test("an interrupt ends a read with 130 and aborts ctx.signal; a write runs to completion", async (t) => {
  const home = await cliHome(t);
  let readAborted = false;
  let writeSawAbort = false;
  let writeFinished = false;
  let interruptWrite;
  const family = defineFamily({
    name: "long",
    stability: "experimental",
    summary: "long",
    commands: [
      {
        name: "wait",
        summary: "wait",
        mutation: "read",
        run: (ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { readAborted = true; }); }),
      },
      {
        name: "journal",
        summary: "journal",
        mutation: "write",
        // No ctx.critical here on purpose: a family that forgets it must still
        // never report INTERRUPTED over a mutation that goes on to land.
        async run(ctx) {
          interruptWrite();
          await new Promise((resolve) => setTimeout(resolve, 50));
          writeSawAbort = ctx.signal.aborted;
          writeFinished = true;
          return { data: { written: true } };
        },
      },
    ],
  });
  const table = testTable(family);
  const waiting = await runContextcake(["long", "wait", "--json"], home, { table, interrupt: new Promise((resolve) => setTimeout(resolve, 10)) });
  assert.equal(waiting.exitCode, 130);
  assert.equal(waiting.json.error.code, "INTERRUPTED");
  assert.equal(readAborted, true, "ctx.signal aborts so the read can stop its work");

  const write = await runContextcake(["long", "journal", "--json"], home, { table, interrupt: new Promise((resolve) => { interruptWrite = resolve; }) });
  assert.equal(writeFinished, true);
  assert.equal(writeSawAbort, true, "the write could see the interrupt through ctx.signal");
  assert.equal(write.exitCode, 0, "the answer reports what happened: the write landed");
  assert.deepEqual(write.json.data, { written: true });
});

test("spawned entrypoints never receive global flags they do not implement", async (t) => {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  const cases = [
    [["write", "--signals", "s.json", "--json", "--dry-run"], "INVALID_INPUT"],
    [["write", "--signals", "s.json", "--quiet"], "INVALID_INPUT"],
    [["write", "--signals", "s.json", "--timeout", "5s"], "TIMEOUT_REFUSED"],
    [["promote", "--timeout=5s"], "TIMEOUT_REFUSED"],
    [["pack", "list", "--no-input"], "INVALID_INPUT"],
    [["ingest", "--expect-revision", "sha256:x"], "INVALID_INPUT"],
    [["resolve", "--concept", "a", "--json"], "INVALID_INPUT"],
    [["resolve", "--concept", "a", "--timeout", "1s"], "INVALID_INPUT"],
  ];
  for (const [argv, code] of cases) {
    let spawned = false;
    const result = await runContextcake([...argv], home, { wrapSpawn: () => { spawned = true; return { args: ["-e", ""], env: {} }; } });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(spawned, false, `${argv.join(" ")} must not start the entrypoint`);
    if (result.json) assert.equal(result.json.error.code, code);
    else assert.match(result.stderr, code === "TIMEOUT_REFUSED" ? /timeout/ : /does not accept/);
  }
  // doctor implements --json itself, so it passes through.
  const doctor = TABLE.byId.get("doctor");
  assert.deepEqual(prepareSpawnArgs(doctor, ["--json"], { manifestPath: home.manifestPath }), ["--manifest", home.manifestPath, "--json"]);
  // Position does not matter: the older parsers would swallow the next
  // argument either way. After `--` nothing is a flag.
  const write = TABLE.byId.get("write");
  assert.throws(() => prepareSpawnArgs(write, ["--signals", "--json"], { manifestPath: home.manifestPath }), /does not accept --json/);
  assert.deepEqual(prepareSpawnArgs(write, ["--", "--json"], { manifestPath: home.manifestPath }).slice(2), ["--", "--json"]);
});

test("redaction keeps Dates, URLs, Buffers, Errors, and shared references intact", () => {
  const { redact } = createRedactor([]);
  const shared = { name: "notes" };
  const when = new Date("2026-09-16T00:00:00Z");
  const out = redact({
    when,
    url: new URL("https://example.com/a?b=c"),
    bytes: Buffer.from("hi"),
    failure: Object.assign(new Error("boom"), { code: "EBOOM" }),
    sources: [shared],
    degraded: [shared],
  });
  assert.equal(out.when, when.toJSON());
  assert.equal(out.url, "https://example.com/a?b=c");
  assert.deepEqual(out.bytes, { type: "Buffer", data: [104, 105] });
  assert.equal(out.failure.message, "boom");
  assert.equal(out.failure.code, "EBOOM");
  assert.deepEqual(out.sources, [{ name: "notes" }]);
  assert.deepEqual(out.degraded, [{ name: "notes" }]);
  const loop = { a: 1 };
  loop.self = loop;
  assert.equal(redact(loop).self, "[circular]");
});

test("a mutation reports the revision it wrote, not whatever is on disk afterwards", async (t) => {
  const home = await cliHome(t);
  await writeManifest(home, { profiles: { default: { label: "Default", layers: [] } } });
  const written = `sha256:${"a".repeat(64)}`;
  const family = defineFamily({
    name: "race",
    stability: "experimental",
    summary: "race",
    commands: [{
      name: "write",
      summary: "race",
      mutation: "write",
      manifest: "required",
      async run(ctx) {
        ctx.readManifest();
        ctx.noteManifestWrite(written.slice("sha256:".length));
        // Another writer lands after our lock was released.
        await fs.writeFile(home.manifestPath, JSON.stringify({ profiles: { default: { label: "Other", layers: [] } } }));
        return { data: null };
      },
    }],
  });
  const result = await runContextcake(["race", "write", "--json"], home, { table: testTable(family) });
  assert.equal(result.json.context.manifestRevision, written);
});

test("a command that must see every source exits 6 on partial coverage without --require-complete", async (t) => {
  const home = await cliHome(t);
  const coverage = { complete: false, degraded: [{ source: "remote", reason: "timeout" }] };
  const family = defineFamily({
    name: "probe",
    stability: "experimental",
    summary: "probe",
    commands: [{ name: "test", summary: "probe", mutation: "read", coverage: true, requireComplete: true, run: () => ({ data: [], coverage }) }],
  });
  const result = await runContextcake(["probe", "test", "--json"], home, { table: testTable(family) });
  assert.equal(result.exitCode, 6);
  assert.equal(result.json.error.code, "INCOMPLETE_COVERAGE");
  const [described] = (await runContextcake(["help", "--json"], home, { table: testTable(family) })).json.data.commands;
  assert.equal(described.requireComplete, true);
  assert.throws(() => defineFamily({ name: "bad", stability: "experimental", summary: "b", commands: [{ name: "x", summary: "x", mutation: "read", requireComplete: true, run: () => ({ data: null }) }] }), /requireComplete needs coverage/);
});
