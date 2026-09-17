import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createFilesSource } from "../src/sources/files.mjs";
import { createRetainedSearch } from "../src/retained-search.mjs";
import { searchConcepts } from "../src/search.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cc-retained-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "database.md"), "# Database\n\n## Engine\n\nPostgres is the production database.");
  await writeFile(path.join(root, "deploy.md"), "# Deploy\n\n## Release\n\nDeploy the server after database migration.");
  const source = createFilesSource({ name: "docs", level: 1, root });
  return { root, source };
}

// The whole point of the store-backed rework: parsed documents are NOT
// retained in the JS heap between queries, so "loaded nothing" (not "reused
// a retained parse") is the thing every test below proves.

test("repeated queries load nothing once synced; edits, deletes and additions equal fresh ranking and cost exactly one read each", async (t) => {
  const { root, source } = await fixture(t);
  const retained = createRetainedSearch([source]);
  t.after(() => retained.close());
  await assert.rejects(retained.search({ query: "!!!" }), /non-empty query/);
  assert.equal(retained._debug.documentsRead, 0, "invalid queries never scan the corpus");

  const first = await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 2, "first query analyzes every document once");
  assert.deepEqual(first.hits, await searchConcepts([source], { query: "database" }));

  const readsAfterFirst = retained._debug.documentsRead;
  const next = await retained.search({ query: "migration" });
  assert.equal(retained._debug.documentsRead, readsAfterFirst, "a new query over unchanged content loads zero documents");
  assert.equal(next.sources[0], source, "the real adapter is returned, not a point-in-time snapshot wrapper");

  await writeFile(path.join(root, "database.md"), "# Database\n\n## Engine\n\nSQLite now stores the embedded database.");
  await utimes(path.join(root, "database.md"), new Date(), new Date(Date.now() + 1000));
  const edited = await retained.search({ query: "sqlite database" });
  assert.equal(retained._debug.documentsRead, readsAfterFirst + 1, "one changed file costs exactly one read");
  assert.deepEqual(edited.hits, await searchConcepts([source], { query: "sqlite database" }));

  const readsAfterEdit = retained._debug.documentsRead;
  await rm(path.join(root, "deploy.md"));
  await writeFile(path.join(root, "new.md"), "# New\n\nNew SQLite migration guidance.");
  const changed = await retained.search({ query: "sqlite" });
  assert.equal(retained._debug.documentsRead, readsAfterEdit + 1, "one new file costs one read; the deletion costs none");
  assert.deepEqual(changed.hits, await searchConcepts([source], { query: "sqlite" }));
});

test("concurrent queries share one refresh pass", async (t) => {
  const { source } = await fixture(t);
  let lists = 0;
  const retained = createRetainedSearch([{
    ...source,
    async listEntries(options) { lists++; await sleep(5); return source.listEntries(options); },
  }]);
  t.after(() => retained.close());
  const [a, b] = await Promise.all([
    retained.search({ query: "database" }),
    retained.search({ query: "deploy" }),
  ]);
  assert.equal(lists, 1, "one listing pass serves both concurrent queries");
  assert.equal(retained._debug.documentsRead, 2, "each of the two documents is loaded exactly once across both queries");
  assert.deepEqual(a.hits, await searchConcepts([source], { query: "database" }));
  assert.deepEqual(b.hits, await searchConcepts([source], { query: "deploy" }));
});

test("remote documents without fingerprints refresh every query and reuse only identical content (via the store's content hash)", async (t) => {
  let text = "Postgres database";
  const source = {
    name: "remote",
    level: 1,
    async listConceptIds() { return ["db"]; },
    async loadConcept() { return { frontmatter: {}, sections: [{ key: "body", text }] }; },
  };
  const retained = createRetainedSearch([source]);
  t.after(() => retained.close());
  const before = await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 1);
  const same = await retained.search({ query: "database" });
  // No fileMeta means the store can't prove the id unchanged without reading
  // it, so it is reloaded every query — but the store's own content-hash
  // fingerprint recognizes the identical body and does not re-analyze it.
  assert.equal(retained._debug.documentsRead, 2, "an unfingerprinted source is reloaded every query");
  assert.deepEqual(same.hits, before.hits);
  text = "SQLite database";
  const after = await retained.search({ query: "sqlite" });
  assert.equal(retained._debug.documentsRead, 3);
  assert.deepEqual(after.hits, await searchConcepts([source], { query: "sqlite" }));
});

test("fingerprint includes authored date even when file bytes and stat do not change", async (t) => {
  let authoredDate = "2026-01-01";
  const retained = createRetainedSearch([{
    name: "history",
    level: 1,
    async listEntries() { return [{ id: "a", rel: "a.md", ext: ".md", size: 10, mtimeMs: 1, authoredDate }]; },
    async loadConcept() { return { frontmatter: { updated: authoredDate }, sections: [{ key: "body", text: "database" }] }; },
  }]);
  t.after(() => retained.close());
  await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 1);
  authoredDate = "2026-02-01";
  await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 2, "an authored-date-only change (no byte or stat change) still costs exactly one read");
});

test("stdio retrieval is app-independent, profile-bound, current after edit", async (t) => {
  const { root } = await fixture(t);
  const team = path.join(root, "team");
  const other = path.join(root, "other");
  await mkdir(team); await mkdir(other);
  await writeFile(path.join(team, "database.md"), "# Database\n\n## Engine\n\nMySQL is the production database.");
  await writeFile(path.join(other, "secret.md"), "# Secret\n\nUnrelated secret database.");
  const manifest = path.join(root, "layers.json");
  await writeFile(manifest, JSON.stringify({
    profiles: {
      default: { label: "Default", layers: [{ name: "personal", source: "files", path: root, level: 3 }, { name: "team", source: "files", path: team, level: 1 }] },
      other: { label: "Other", layers: [{ name: "secrets", source: "files", path: other, level: 1 }] },
    },
  }));
  const child = spawn(process.execPath, ["mcp-server.mjs", "--manifest", manifest, "--profile", "other"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on("line", (line) => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
  let id = 0;
  function call(method, params) {
    return Promise.race([new Promise((resolve) => { const requestId = ++id; waiting.set(requestId, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); }),
      sleep(3000, null, { ref: false }).then(() => { throw new Error(`MCP timeout: ${stderr}`); })]);
  }
  const init = await call("initialize", {});
  assert.equal(init.result._meta.contextcake.selectedProfile.id, "other");
  const search = async (query) => {
    const answer = await call("tools/call", { name: "search", arguments: { query } });
    assert.equal(answer.error, undefined, JSON.stringify(answer));
    return JSON.parse(answer.result.content[0].text);
  };
  assert.deepEqual((await search("database")).map((hit) => hit.id), ["secret"]);
  await writeFile(path.join(other, "secret.md"), "# Secret\n\nUnrelated sqlite guidance.");
  assert.equal((await search("sqlite"))[0].id, "secret");
  assert.deepEqual(await search("database"), []);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
});

test("a failed refresh does not lose persisted content: recovery costs nothing extra when nothing changed", async (t) => {
  const { source } = await fixture(t);
  let fail = false;
  const retained = createRetainedSearch([{
    ...source,
    async listEntries(options) {
      if (fail) { await sleep(30); throw new Error("listing unavailable"); }
      return source.listEntries(options);
    },
  }]);
  t.after(() => retained.close());
  await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 2);
  fail = true;
  await Promise.all([
    assert.rejects(retained.search({ query: "database" }), /listing unavailable/),
    assert.rejects(retained.search({ query: "deploy" }), /listing unavailable/),
  ]);
  fail = false;
  const answer = await retained.search({ query: "database" });
  assert.equal(retained._debug.documentsRead, 2, "content already durably indexed needs no re-read once the source recovers");
  assert.deepEqual(answer.hits, await searchConcepts([source], { query: "database" }));
});

test("no parsed concept is retained across queries or a process restart", async (t) => {
  // Registered before the fixture's cleanup: node:test runs after-hooks in
  // order, and Windows refuses to delete a folder holding an open SQLite file.
  let retained2 = null;
  t.after(() => retained2?.close());
  const { root, source } = await fixture(t);
  const storeFile = path.join(root, "search.sqlite");

  const retained1 = createRetainedSearch([source], { file: storeFile });
  const first = await retained1.search({ query: "database" });
  assert.equal(retained1._debug.documentsRead, 2, "first query analyzes every document");
  const before = retained1._debug.documentsRead;
  await retained1.search({ query: "deploy" });
  assert.equal(retained1._debug.documentsRead, before, "a second query over unchanged content loads zero documents");
  retained1.close();

  // A fresh instance over the SAME file — standing in for a new mcp-server
  // process spawned against the same profile — must answer its very first
  // query without re-parsing anything: the postings are already on disk.
  retained2 = createRetainedSearch([source], { file: storeFile });
  const restarted = await retained2.search({ query: "database" });
  assert.equal(retained2._debug.documentsRead, 0, "a fresh instance over the same store file loads zero documents on its first query");
  assert.deepEqual(restarted.hits, first.hits);
});

test("CONTEXTCAKE_DISABLE_SEARCH_STORE forces the in-memory fallback, and it ranks identically to the store-backed path", async (t) => {
  // The fallback (createLegacyRetainedSearch) is otherwise unreachable on any
  // Node this engine supports (>=22.13, where node:sqlite ships unflagged) —
  // this env var is the DI seam that makes it testable. See search-store.mjs.
  const { root, source } = await fixture(t);
  process.env.CONTEXTCAKE_DISABLE_SEARCH_STORE = "1";
  t.after(() => { delete process.env.CONTEXTCAKE_DISABLE_SEARCH_STORE; });

  const retained = createRetainedSearch([source]);
  t.after(() => retained.close());
  assert.equal(retained.backend, "memory", "the env var must force the legacy in-memory path");
  const result = await retained.search({ query: "database" });
  assert.equal(result.stats.phase, "cold", "the first query still reports a real phase from the legacy path's own stats");
  assert.deepEqual(result.hits, await searchConcepts([source], { query: "database" }), "the fallback must rank identically to the reference scorer");

  // A second query over unchanged content still costs nothing to re-index —
  // the legacy path's own idle-evicted in-memory index reports it as warm,
  // same contract as the store-backed path, just without the _debug counter
  // (which only the store-backed implementation exposes).
  const second = await retained.search({ query: "deploy" });
  assert.equal(second.stats.phase, "warm", "unchanged content is warm under the fallback too");
  assert.equal(second.stats.documentsRead, 0);
  assert.deepEqual(second.hits, await searchConcepts([source], { query: "deploy" }));
});
