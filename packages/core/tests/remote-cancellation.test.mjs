import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGithubSource } from "../src/sources/github.mjs";
import { createMcpSource } from "../src/sources/mcp.mjs";
import { withCache } from "../src/sources/cache.mjs";

test("GitHub listing abort cancels fetch without recording an outage or retry cooldown", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let aborted = false;
  let blocked = true;
  globalThis.fetch = async (url, { signal }) => {
    if (blocked) return new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    return new Response(JSON.stringify(url.pathname.endsWith("/repo") ? { default_branch: "main" } : { tree: [] }));
  };
  const source = createGithubSource({ name: "github", level: 1, repo: "owner/repo" });
  const controller = new AbortController();
  const pending = source.listConceptIds({ signal: controller.signal });
  controller.abort(new Error("Cancelled by index budget"));
  await assert.rejects(pending, /Cancelled by index budget/);
  assert.equal(aborted, true);
  assert.equal(source.health().ok, true);
  blocked = false;
  assert.deepEqual(await source.listConceptIds(), [], "direct reads remain usable immediately after cancellation");
  assert.notEqual(source.health().lastSuccessAt, null);
});

test("GitHub abort during content read propagates through the cache and does not cache a missing document", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let blocked = true;
  let contentRequested;
  const contentStarted = new Promise((resolve) => { contentRequested = resolve; });
  globalThis.fetch = async (url, { signal }) => {
    if (url.pathname.includes("/contents/")) {
      contentRequested();
      if (blocked) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return new Response("# Database\n\nUse Postgres.");
    }
    if (url.pathname.includes("/commits")) return new Response("[]");
    return new Response(JSON.stringify(url.pathname.endsWith("/repo") ? { default_branch: "main" }
      : { tree: [{ type: "blob", path: "README.md", size: 20 }] }));
  };
  const raw = createGithubSource({ name: "github", level: 1, repo: "owner/repo", paths: ["README.md"] });
  const source = withCache(raw);
  const controller = new AbortController();
  const pending = source.loadConcept("owner/repo/README", { signal: controller.signal });
  await contentStarted;
  controller.abort(new Error("Stop content read"));
  await assert.rejects(pending, /Stop content read/);
  assert.equal(raw.health().ok, true);
  blocked = false;
  assert.ok(await source.loadConcept("owner/repo/README"));
});

test("foreign MCP cancels the request and remains available to other readers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-cancel-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const script = path.join(root, "foreign.mjs");
  await writeFile(script, `
    import readline from 'node:readline';
    let cancelled = false;
    let listCalls = 0;
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      if (m.method === 'initialize') reply({});
      if (m.method === 'tools/list') reply({ tools: [{name:'list_nodes'}, {name:'get_node'}] });
      if (m.method === 'notifications/cancelled') cancelled = true;
      if (m.method === 'tools/call') {
        if (m.params.name === 'list_nodes' && ++listCalls === 1) return;
        reply({ content: [{type:'text', text: JSON.stringify({ nodes: [cancelled ? 'cancelled-cleanly' : 'bad'] })}] });
      }
    });
  `);
  const source = createMcpSource({ name: "foreign", level: 1, command: process.execPath, args: [script] });
  t.after(() => source.close());
  await source.probe();
  const controller = new AbortController();
  const pending = source.listConceptIds({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error("Index cancelled")), 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, /Index cancelled/);
  assert.equal(source.health().ok, true);
  assert.deepEqual(await source.listConceptIds(), ["cancelled-cleanly"]);
});

test("pre-aborted remote calls do not spawn children or start network requests", async () => {
  const controller = new AbortController(); controller.abort(new Error("Already cancelled"));
  const sources = [createGithubSource({ name: "g", level: 1, repo: "a/b" }),
    createMcpSource({ name: "m", level: 1, command: "missing-mcp-binary" })];
  for (const source of sources) {
    await assert.rejects(source.listConceptIds({ signal: controller.signal }), /Already cancelled/);
    assert.equal(source.health().ok, true);
    source.close();
  }
});
