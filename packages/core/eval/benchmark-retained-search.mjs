#!/usr/bin/env node
// Controlled headless retrieval benchmark. Temporary documents only; does not
// touch a user's manifest or installed app. Run from any directory with Node.
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createFilesSource } from "../src/sources/files.mjs";
import { createRetainedSearch } from "../src/retained-search.mjs";
import { searchConcepts } from "../src/search.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const count = Number(process.argv[2] ?? 3000);
if (!Number.isInteger(count) || count < 1 || count > 25_000) throw new Error("Document count must be 1..25000");
const root = await mkdtemp(path.join(tmpdir(), "cc-retrieval-bench-"));
const base = createFilesSource({ name: "project", level: 1, root });
let reads = 0;
const source = { ...base, async loadConcept(...args) { reads++; return base.loadConcept(...args); } };
const retained = createRetainedSearch([source]);
const timings = [];
const children = [];
let corpusBytes = 0;
function client(manifest) {
  const entrypoint = fileURLToPath(new URL("../../../mcp-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [entrypoint, "--manifest", manifest], { stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  let sequence = 0;
  const waiting = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  child.on("exit", () => { for (const waiter of waiting.values()) waiter.reject(new Error("MCP exited")); });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return {
    initialize: () => call("initialize", {}),
    search: async (options) => JSON.parse((await call("tools/call", { name: "search", arguments: options })).content[0].text),
  };
}
async function measure(label, fn) {
  const startReads = reads;
  const started = performance.now();
  const result = await fn();
  timings.push({ label, milliseconds: +(performance.now() - started).toFixed(2), documentsRead: label.includes("stdio") ? null : reads - startReads });
  return result;
}
try {
  for (let i = 0; i < count; i++) {
    const topic = ["database", "deployment", "authentication", "indexing", "incident"][i % 5];
    const paragraph = `The ${topic} service uses bounded concurrency and deterministic retries. Record provenance for each project decision. Production migrations require a current snapshot and verified rollback. Cache invalidation preserves source identity and section dates. `;
    const content = `# Project ${topic} ${i}\n\n## Decision\n\n${paragraph.repeat(120)}`;
    corpusBytes += Buffer.byteLength(content);
    await writeFile(path.join(root, `note-${String(i).padStart(5, "0")}.md`), content);
  }
  const query = { query: "database migrations", limit: 10 };
  const fresh = await measure("previous full rebuild", () => searchConcepts([source], query));
  const cold = await measure("retained cold query", () => retained.search(query));
  assert.deepEqual(cold.hits, fresh);
  for (let i = 0; i < 3; i++) {
    const warm = await measure(`retained repeated query ${i + 1}`, () => retained.search(query));
    assert.deepEqual(warm.hits, fresh);
  }
  await measure("retained different query", () => retained.search({ query: "authentication rollback" }));
  const manifest = path.join(root, "layers.json");
  await writeFile(manifest, JSON.stringify({ layers: [{ name: "project", source: "files", path: root, level: 1 }] }));
  const a = client(manifest);
  const b = client(manifest);
  await measure("two stdio clients initialize", () => Promise.all([a.initialize(), b.initialize()]));
  const clientsCold = await measure("two stdio clients cold search concurrently", () => Promise.all([a.search(query), b.search(query)]));
  for (const hits of clientsCold) assert.deepEqual(hits, fresh);
  for (let i = 0; i < 3; i++) {
    const hits = await measure(`stdio repeated query ${i + 1}`, () => a.search(query));
    assert.deepEqual(hits, fresh);
  }
  await measure("stdio different query", () => a.search({ query: "authentication rollback" }));
  const editPath = path.join(root, "note-00000.md");
  await writeFile(editPath, "# Updated database decision\n\n## Decision\n\nSQLite migrations replace the previous database guidance.");
  await utimes(editPath, new Date(), new Date(Date.now() + 1000));
  const changed = await measure("retained after one edit", () => retained.search(query));
  assert.deepEqual(changed.hits, await searchConcepts([base], query));
  const clientsChanged = await measure("two stdio clients after one edit", () => Promise.all([a.search(query), b.search(query)]));
  for (const hits of clientsChanged) assert.deepEqual(hits, changed.hits);
  console.log(JSON.stringify({ documents: count, corpusBytes, node: process.version, rankingEquivalent: true, timings }, null, 2));
} finally {
  for (const child of children) child.kill();
  retained.close();
  await rm(root, { recursive: true, force: true });
}
