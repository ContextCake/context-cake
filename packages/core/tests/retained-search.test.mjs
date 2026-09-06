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

test("repeated queries reuse parsed documents; edits, deletes and additions equal fresh ranking", async (t) => {
  const { root, source } = await fixture(t);
  let reads = 0;
  const retained = createRetainedSearch([{ ...source, async loadConcept(...args) { reads++; return source.loadConcept(...args); } }]);
  t.after(() => retained.close());
  await assert.rejects(retained.search({ query: "!!!" }), /non-empty query/);
  assert.equal(reads, 0, "invalid queries never scan the corpus");
  const first = await retained.search({ query: "database" });
  assert.equal(reads, 2);
  assert.deepEqual(first.hits, await searchConcepts([source], { query: "database" }));
  const next = await retained.search({ query: "migration" });
  assert.equal(reads, 2, "a new query must not reread the corpus");
  assert.equal(first.sources[0], next.sources[0], "unchanged listing preserves generation");
  await writeFile(path.join(root, "database.md"), "# Database\n\n## Engine\n\nSQLite now stores the embedded database.");
  await utimes(path.join(root, "database.md"), new Date(), new Date(Date.now() + 1000));
  const edited = await retained.search({ query: "sqlite database" });
  assert.equal(reads, 3, "one changed file costs one read");
  assert.deepEqual(edited.hits, await searchConcepts([source], { query: "sqlite database" }));
  await rm(path.join(root, "deploy.md"));
  await writeFile(path.join(root, "new.md"), "# New\n\nNew SQLite migration guidance.");
  const changed = await retained.search({ query: "sqlite" });
  assert.equal(reads, 4);
  assert.deepEqual(changed.hits, await searchConcepts([source], { query: "sqlite" }));
  assert.equal(changed.sources[0].concepts.has("deploy"), false);
});

test("concurrent queries share a pass and idle eviction releases the retained generation", async (t) => {
  const { source } = await fixture(t);
  let lists = 0;
  let reads = 0;
  const retained = createRetainedSearch([{ ...source,
    async listEntries(options) { lists++; await sleep(5); return source.listEntries(options); },
    async loadConcept(...args) { reads++; return source.loadConcept(...args); },
  }], { idleEvictMs: 20 });
  t.after(() => retained.close());
  await Promise.all([retained.search({ query: "database" }), retained.search({ query: "deploy" })]);
  assert.equal(lists, 1);
  assert.equal(reads, 2);
  await sleep(50);
  await retained.search({ query: "database" });
  assert.equal(reads, 4, "idle eviction drops parsed content as well as scoring maps");
});

test("remote documents without fingerprints refresh and reuse only identical content", async (t) => {
  let text = "Postgres database";
  const source = { name: "remote", level: 1, async listConceptIds() { return ["db"]; },
    async loadConcept() { return { frontmatter: {}, sections: [{ key: "body", text }] }; } };
  const retained = createRetainedSearch([source]);
  t.after(() => retained.close());
  const before = await retained.search({ query: "database" });
  const same = await retained.search({ query: "database" });
  assert.equal(before.sources[0], same.sources[0]);
  text = "SQLite database";
  const after = await retained.search({ query: "sqlite" });
  assert.notEqual(before.sources[0], after.sources[0]);
  assert.deepEqual(after.hits, await searchConcepts([source], { query: "sqlite" }));
});

test("fingerprint includes authored date even when file bytes and stat do not change", async (t) => {
  let authoredDate = "2026-01-01";
  let reads = 0;
  const retained = createRetainedSearch([{ name: "history", level: 1,
    async listEntries() { return [{ id: "a", rel: "a.md", ext: ".md", size: 10, mtimeMs: 1, authoredDate }]; },
    async loadConcept() { reads++; return { frontmatter: { updated: authoredDate }, sections: [{ key: "body", text: "database" }] }; },
  }]);
  t.after(() => retained.close());
  await retained.search({ query: "database" });
  authoredDate = "2026-02-01";
  const after = await retained.search({ query: "database" });
  assert.equal(reads, 2);
  assert.equal(after.sources[0].concepts.get("a").frontmatter.updated, authoredDate);
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
