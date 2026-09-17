// `contextcake concept` and `contextcake file` (control-plane spec §5.7 read
// half, §5.2 coverage). Parity per design §10: on the same fixture, the CLI's
// data equals what the HTTP service answers (/api/resolve, /api/search,
// /api/files, /api/file) and what MCP answers (list_concepts, get_links).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEngineService } from "../src/service.mjs";
import { cliHome, runContextcake, writeManifest } from "./helpers/cli-harness.mjs";

const MCP_SERVER = fileURLToPath(new URL("../src/mcp-server.mjs", import.meta.url));

const doc = (frontmatter, body) => `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}`;

async function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
}

// Two okf-local layers that disagree on one section and link to each other.
async function fixture(t, { extraLayers = [], profiles = {} } = {}) {
  const home = await cliHome(t);
  const personal = path.join(home.dir, "personal");
  const team = path.join(home.dir, "team");
  await writeFiles(personal, {
    "decisions/primary-db.md": doc({ title: "Primary database", type: "decision", updated: "2026-09-10" }, "## Engine {#engine}\n\nUse MySQL for the primary database.\n"),
    "notes/scratch.md": doc({ title: "Scratch", type: "note" }, "## Body {#body}\n\nPostgres tuning ideas.\n"),
  });
  await writeFiles(team, {
    "decisions/primary-db.md": doc({ title: "Primary database", type: "decision", updated: "2026-09-15" }, "## Engine {#engine}\n\nUse Postgres for the primary database. Deploy per [[/guides/deploy]].\n\n## Backups {#backups}\n\nNightly snapshots.\n"),
    "guides/deploy.md": doc({ title: "Deploy guide", type: "guide" }, "## Steps {#steps}\n\nCheck [[/decisions/primary-db]] before a deploy.\n"),
    "assets/readme.txt": "plain text file\n",
  });
  const layers = [
    { name: "personal", path: personal, level: 3 },
    { name: "team", path: team, level: 1 },
    ...extraLayers,
  ];
  await writeManifest(home, { profiles: { default: { label: "Default", layers }, ...profiles } });
  return { home, personal, team };
}

async function startService(t, manifestPath) {
  const service = createEngineService({ manifestPath });
  const server = http.createServer(async (req, res) => {
    if (await service.handleRequest(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return async (route, params = {}) => {
    const url = new URL(`http://127.0.0.1:${server.address().port}${route}`);
    url.search = new URLSearchParams(params);
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  };
}

async function startMcp(t, manifestPath, cwd) {
  const child = spawn(process.execPath, [MCP_SERVER, "--manifest", manifestPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let sequence = 0;
  return (name, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(JSON.parse(message.result.content[0].text));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
}

test("concept read equals /api/resolve, keeps conflicts and fresherDissent, and renders the MCP markdown", async (t) => {
  const { home } = await fixture(t);
  const api = await startService(t, home.manifestPath);
  const http = await api("/api/resolve", { concept: "decisions/primary-db" });
  assert.equal(http.status, 200, JSON.stringify(http.body));

  const cli = await runContextcake(["concept", "read", "decisions/primary-db", "--json"], home);
  assert.equal(cli.exitCode, 0, cli.stdout);
  assert.deepEqual(cli.json.data, http.body);
  const engine = cli.json.data.sections.find((section) => section.key === "engine");
  assert.equal(engine.sourceLayer, "personal");
  assert.equal(engine.conflicts[0].layer, "team");
  assert.equal(engine.fresherDissent, true);
  assert.equal(engine.discrepancy.status, "needs_review");
  assert.deepEqual(cli.json.coverage, { complete: true, sources: [{ name: "personal", kind: "okf-local", status: "ok" }, { name: "team", kind: "okf-local", status: "ok" }], degraded: [] });
  assert.equal(cli.json.context.profileId, "default");
  assert.ok(cli.json.nextActions.some((action) => action.command === "concept.links"));

  const text = await runContextcake(["concept", "read", "decisions/primary-db"], home);
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /^---\ntitle: Primary database/);
  assert.match(text.stdout, /> ⚠ team disagrees \(updated 2026-09-15\) — ⚠ newer than the effective value:\n> Use Postgres/);

  const missing = await runContextcake(["concept", "read", "decisions/nope", "--json"], home);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.json.error.code, "NOT_FOUND");
});

test("concept search equals /api/search, with the type and source filters and the limit cap", async (t) => {
  const { home } = await fixture(t);
  const api = await startService(t, home.manifestPath);
  for (const [argv, params] of [
    [["postgres", "database"], { q: "postgres database" }],
    [["postgres", "--type", "note"], { q: "postgres", type: "note" }],
    [["postgres", "--source", "team"], { q: "postgres", source: "team" }],
    [["primary", "--limit", "1"], { q: "primary", limit: "1" }],
  ]) {
    const http = await api("/api/search", { ...params, wait: "15000" });
    assert.equal(http.status, 200, JSON.stringify(http.body));
    assert.equal(http.body.indexing, false);
    const cli = await runContextcake(["concept", "search", ...argv, "--json"], home);
    assert.equal(cli.exitCode, 0, cli.stdout);
    assert.ok(http.body.hits.length > 0, `fixture must match ${argv.join(" ")}`);
    assert.deepEqual(cli.json.data.hits, http.body.hits, argv.join(" "));
    assert.equal(cli.json.coverage.complete, true);
  }
  const punctuation = await runContextcake(["concept", "search", "!!!", "--json"], home);
  assert.equal(punctuation.exitCode, 0);
  assert.deepEqual(punctuation.json.data.hits, []);

  const text = await runContextcake(["concept", "search", "postgres", "database"], home);
  assert.match(text.stdout, /^1\. decisions\/primary-db {2}Primary database {2}\(personal, team\)/);
  const badLimit = await runContextcake(["concept", "search", "x", "--limit", "0", "--json"], home);
  assert.equal(badLimit.exitCode, 2);
});

test("concept list and links equal MCP list_concepts and get_links", async (t) => {
  const { home } = await fixture(t);
  const call = await startMcp(t, home.manifestPath, home.dir);

  const list = await runContextcake(["concept", "list", "--json"], home);
  assert.equal(list.exitCode, 0, list.stdout);
  assert.deepEqual(list.json.data, await call("list_concepts", {}));
  assert.deepEqual(list.json.data.map((row) => row.id), ["decisions/primary-db", "guides/deploy", "notes/scratch"]);
  const typed = await runContextcake(["concept", "list", "--type", "guide", "--json"], home);
  assert.deepEqual(typed.json.data, await call("list_concepts", { type: "guide" }));

  const links = await runContextcake(["concept", "links", "decisions/primary-db", "--json"], home);
  assert.equal(links.exitCode, 0, links.stdout);
  assert.deepEqual(links.json.data, await call("get_links", { concept_id: "decisions/primary-db" }));
  assert.deepEqual(links.json.data.incoming.map((row) => row.id), ["guides/deploy"]);
  const guide = await runContextcake(["concept", "links", "guides/deploy", "--json"], home);
  assert.deepEqual(guide.json.data, await call("get_links", { concept_id: "guides/deploy" }));

  const text = await runContextcake(["concept", "links", "guides/deploy"], home);
  assert.match(text.stdout, /Outgoing:\n {2}\/decisions\/primary-db -> decisions\/primary-db {2}\(personal, team\)\nIncoming:\n {2}decisions\/primary-db {2}\(team\)/);
  const missing = await runContextcake(["concept", "links", "nope", "--json"], home);
  assert.equal(missing.exitCode, 3);
});

test("file list and read equal /api/files and /api/file, inside the layer-root sandbox", async (t) => {
  const { home } = await fixture(t);
  const api = await startService(t, home.manifestPath);
  const files = await api("/api/files");
  const cli = await runContextcake(["file", "list", "--json"], home);
  assert.equal(cli.exitCode, 0, cli.stdout);
  assert.deepEqual(cli.json.data, files.body);
  assert.equal(cli.json.coverage.complete, true);

  for (const filePath of ["team/decisions/primary-db.md", "team/assets/readme.txt"]) {
    const http = await api("/api/file", { path: filePath });
    const read = await runContextcake(["file", "read", filePath, "--json"], home);
    assert.equal(read.exitCode, 0, read.stdout);
    assert.deepEqual(read.json.data, http.body);
    assert.ok(!Object.hasOwn(read.json, "coverage"), "a single file read reports no coverage");
  }
  const text = await runContextcake(["file", "read", "team/assets/readme.txt"], home);
  assert.equal(text.stdout, "plain text file\n");

  const escape = await runContextcake(["file", "read", "team/../personal/decisions/primary-db.md", "--json"], home);
  assert.equal(escape.exitCode, 5);
  assert.equal(escape.json.error.code, "PATH_OUTSIDE_LAYER");
  const missing = await runContextcake(["file", "read", "team/nope.md", "--json"], home);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.json.error.code, "NOT_FOUND");
  const unknownLayer = await runContextcake(["file", "read", "elsewhere/x.md", "--json"], home);
  assert.equal(unknownLayer.exitCode, 3);
});

test("a missing folder or invalid layer is read around: exit 0 with incomplete coverage, exit 6 with --require-complete", async (t) => {
  const { home } = await fixture(t, {
    extraLayers: [{ name: "gone", source: "files", path: "does-not-exist", level: 0 }],
  });
  // Hand-edit a layer the validator refuses, as a user might.
  const manifest = JSON.parse(await fs.readFile(home.manifestPath, "utf8"));
  manifest.profiles.default.layers.push({ name: "broken", source: "no-such-kind", path: "x", level: 0 });
  await writeManifest(home, manifest);

  for (const argv of [["concept", "list"], ["concept", "search", "postgres"], ["concept", "read", "decisions/primary-db"], ["concept", "links", "guides/deploy"], ["file", "list"]]) {
    const partial = await runContextcake([...argv, "--json"], home);
    assert.equal(partial.exitCode, 0, `${argv.join(" ")}: ${partial.stdout}`);
    assert.equal(partial.json.coverage.complete, false);
    const degraded = Object.fromEntries(partial.json.coverage.degraded.map((row) => [row.source, row.status]));
    if (argv[0] === "concept") assert.equal(degraded.gone, "unavailable", argv.join(" "));
    assert.equal(degraded.broken, "unavailable", argv.join(" "));
    assert.ok(partial.json.warnings.some((warning) => warning.code === "LAYER_QUARANTINED"));
    assert.ok(partial.json.nextActions.some((action) => action.command === "doctor"));
    assert.match(partial.json.context.manifestRevision, /^sha256:[a-f0-9]{64}$/);

    const strict = await runContextcake([...argv, "--require-complete", "--json"], home);
    assert.equal(strict.exitCode, 6, argv.join(" "));
    assert.equal(strict.json.error.code, "INCOMPLETE_COVERAGE");
  }
  const text = await runContextcake(["concept", "list"], home);
  assert.match(text.stdout, /Some sources could not be read fully:\n {2}! gone: unavailable/);
});

test("queries stay inside the selected profile", async (t) => {
  const { home } = await fixture(t, {
    profiles: { work: { label: "Work", layers: [] } },
  });
  const work = path.join(home.dir, "work");
  await writeFiles(work, { "only-work.md": doc({ title: "Only work", type: "note" }, "## Body {#body}\n\nPostgres at work.\n") });
  const manifest = JSON.parse(await fs.readFile(home.manifestPath, "utf8"));
  manifest.profiles.work.layers.push({ name: "work", path: work, level: 1 });
  await writeManifest(home, manifest);

  const list = await runContextcake(["concept", "list", "--profile", "work", "--json"], home);
  assert.equal(list.exitCode, 0, list.stdout);
  assert.deepEqual(list.json.data.map((row) => row.id), ["only-work"]);
  assert.equal(list.json.context.profileId, "work");
  assert.equal(list.json.context.profileReason, "explicit");
  const search = await runContextcake(["concept", "search", "postgres", "--profile", "work", "--json"], home);
  assert.deepEqual(search.json.data.hits.map((hit) => hit.id), ["only-work"]);
  const read = await runContextcake(["concept", "read", "decisions/primary-db", "--profile", "work", "--json"], home);
  assert.equal(read.exitCode, 3);
  const files = await runContextcake(["file", "read", "team/guides/deploy.md", "--profile", "work", "--json"], home);
  assert.equal(files.exitCode, 3);
  const unknown = await runContextcake(["concept", "list", "--profile", "nope", "--json"], home);
  assert.equal(unknown.exitCode, 3);
  assert.equal(unknown.json.error.code, "PROFILE_NOT_FOUND");
});

test("query commands are read-only, declare coverage, and need a manifest", async (t) => {
  const home = await cliHome(t);
  const help = await runContextcake(["help", "--json"], home);
  const byId = Object.fromEntries(help.json.data.commands.map((command) => [command.id, command]));
  for (const id of ["concept.list", "concept.search", "concept.read", "concept.links", "file.list", "file.read"]) {
    assert.equal(byId[id].mutation, "read", id);
    assert.equal(byId[id].stability, "experimental", id);
    assert.equal(byId[id].coverage, id !== "file.read", id);
  }
  const missing = await runContextcake(["concept", "list", "--json"], home);
  assert.equal(missing.exitCode, 3);
  assert.equal(missing.json.error.code, "MANIFEST_NOT_FOUND");
});

test("--timeout stops a query and exits 6", async (t) => {
  const { home } = await fixture(t);
  const result = await runContextcake(["concept", "list", "--timeout", "1", "--json"], home);
  assert.equal(result.exitCode, 6, result.stdout);
  assert.equal(result.json.error.code, "TIMEOUT");
});
