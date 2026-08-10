// withCache must be transparent, not merely fast.
//
// It wraps ANY adapter — buildSource applies it to a local folder too, the
// moment a layer carries a `cache` block — so anything the wrapper drops on the
// way through is dropped for a local vault as well. Two things travel on the
// listing call and both were being dropped: the index job's abort signal (so a
// cancelled pass kept walking, and a churning layer stacked one live walk per
// cancelled job) and the `notes` collector (so an oversized document or a
// permission-blocked subtree produced a source that was missing documents and
// reported zero warnings).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withCache } from "../src/sources/cache.mjs";
import { createFilesSource } from "../src/sources/files.mjs";

function recordingSource() {
  const calls = [];
  return {
    calls,
    name: "rec",
    level: 1,
    async listConceptIds(options) {
      calls.push(options);
      options?.notes?.skipped.push({ rel: "huge.md", bytes: 99_000_000 });
      options?.notes?.unreadable.push({ rel: "locked", code: "EACCES" });
      // A count, not a list — matches how okf-local's walkDocs reports it.
      if (options?.notes) options.notes.hidden = (options.notes.hidden ?? 0) + 3;
      return ["a", "b"];
    },
    async loadConcept(id) { return { id, sections: [] }; },
    close() {},
  };
}

test("the abort signal reaches the wrapped source", async () => {
  const source = recordingSource();
  const cached = withCache(source, { ttlMs: 60_000 });
  const controller = new AbortController();
  await cached.listConceptIds({ signal: controller.signal, notes: { skipped: [], unreadable: [] } });
  assert.equal(source.calls.length, 1);
  assert.equal(source.calls[0]?.signal, controller.signal, "the wrapper called the source with no signal");
});

test("what the walk could not read survives the wrapper, and the cache hit", async () => {
  const source = recordingSource();
  const cached = withCache(source, { ttlMs: 60_000 });

  const first = { skipped: [], unreadable: [] };
  assert.deepEqual(await cached.listConceptIds({ notes: first }), ["a", "b"]);
  assert.equal(first.skipped.length, 1, "an oversized document never reached the caller");
  assert.equal(first.unreadable.length, 1, "an unreadable subtree never reached the caller");

  // Second read is a memo hit — the source is not called again, and the
  // warnings must not quietly disappear with it.
  const second = { skipped: [], unreadable: [] };
  await cached.listConceptIds({ notes: second });
  assert.equal(source.calls.length, 1, "the memo did not hit");
  assert.deepEqual(second, first, "warnings vanished on the cached read");
});

test("the hidden count survives the wrapper, and does not reset on a cache hit", async () => {
  // hidden is a running total (see okf-local's walkDocs), not a list like
  // skipped/unreadable — replaying it has to add rather than push, or a
  // cached layer's skippedHidden count flickers to 0 on every read but the
  // one that actually walked the disk.
  const source = recordingSource();
  const cached = withCache(source, { ttlMs: 60_000 });

  const first = { skipped: [], unreadable: [], hidden: 0 };
  await cached.listConceptIds({ notes: first });
  assert.equal(first.hidden, 3, "the hidden count from the walk never reached the caller");

  const second = { skipped: [], unreadable: [], hidden: 0 };
  await cached.listConceptIds({ notes: second });
  assert.equal(source.calls.length, 1, "the memo did not hit");
  assert.equal(second.hidden, 3, "the hidden count reset to 0 on the cached read");
});

test("a cached local layer still reports its skipped documents", async () => {
  // The end-to-end shape of the same failure: a real folder, a real oversized
  // file, read through the wrapper a layer's `cache` block would install.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cache-src-"));
  try {
    fs.writeFileSync(path.join(root, "small.md"), "# Small\n\n## Body\n\nfine.\n");
    fs.writeFileSync(path.join(root, "huge.md"), `# Huge\n\n## Body\n\n${"x".repeat(3_000_000)}\n`);
    const source = withCache(createFilesSource({ name: "vault", level: 1, root }), { ttlMs: 60_000 });
    const notes = { skipped: [], unreadable: [] };
    const ids = await source.listConceptIds({ notes });
    assert.deepEqual(ids, ["small"]);
    assert.equal(notes.skipped.length, 1, "the skipped document was indexed silently partial");
    assert.match(notes.skipped[0].rel, /huge\.md$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted listing is not cached as an answer", async () => {
  const source = {
    calls: 0,
    name: "slow",
    level: 1,
    async listConceptIds(options) {
      this.calls += 1;
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      return ["a"];
    },
    async loadConcept() { return null; },
    close() {},
  };
  const cached = withCache(source, { ttlMs: 60_000 });
  const controller = new AbortController();
  controller.abort(new Error("Indexing superseded"));
  await assert.rejects(() => cached.listConceptIds({ signal: controller.signal }));
  assert.deepEqual(await cached.listConceptIds({}), ["a"], "the failure poisoned the cache");
});

test("the memory cache evicts the least-recently-used entry rather than growing forever", async () => {
  // A key touched once and never revisited stayed in `memory` for the life of
  // the process — TTL alone only ever invalidates a key on a read that hits
  // it again. maxEntries bounds that: a long-running desktop session reading
  // through thousands of distinct concept ids must not hold all of them
  // forever just because each one was read exactly once.
  let loads = 0;
  const source = {
    name: "count", level: 1,
    async loadConcept(id) { loads += 1; return { id, sections: [] }; },
    async listConceptIds() { return []; },
    close() {},
  };
  const cached = withCache(source, { ttlMs: 60_000, maxEntries: 2 });
  await cached.loadConcept("a");
  await cached.loadConcept("b");
  assert.equal(loads, 2, "sanity: two distinct ids, two loads so far");

  // A third distinct key pushes the cache over its cap of 2 — "a" (the
  // least recently touched) must be the one evicted, not "b".
  await cached.loadConcept("c");
  assert.equal(loads, 3);

  await cached.loadConcept("b"); // still cached
  assert.equal(loads, 3, "b was evicted when it should not have been");

  await cached.loadConcept("a"); // evicted — must re-load from the source
  assert.equal(loads, 4, "a was not evicted despite being the least recently used");
});

test("reading an entry counts as using it, so a hot key survives eviction", async () => {
  let loads = 0;
  const source = {
    name: "count", level: 1,
    async loadConcept(id) { loads += 1; return { id, sections: [] }; },
    async listConceptIds() { return []; },
    close() {},
  };
  const cached = withCache(source, { ttlMs: 60_000, maxEntries: 2 });

  await cached.loadConcept("a");
  await cached.loadConcept("b");
  await cached.loadConcept("a"); // touch "a" again — "b" is now the LRU one
  assert.equal(loads, 2);

  await cached.loadConcept("c"); // over cap: evicts "b", not "a"
  assert.equal(loads, 3);

  await cached.loadConcept("a"); // still cached — was touched most recently
  assert.equal(loads, 3, "a was evicted despite being the most recently used");

  await cached.loadConcept("b"); // evicted
  assert.equal(loads, 4);
});

test("a full index sweep never evicts the listing itself", async () => {
  // A sweep calls listConceptIds exactly once, then loadConcept once per id —
  // so "list.v2" is always the OLDEST entry in an LRU ordered purely by
  // insertion. On a source with >= maxEntries concepts, capping the listing
  // alongside per-concept entries would throw the listing away first, on
  // every single pass: precisely the most expensive thing withCache exists to
  // save (a full GitHub tree sweep, an MCP list_nodes call) on the remote
  // workload it targets. The listing must survive regardless of how many
  // concept ids get read after it.
  let listLoads = 0;
  let conceptLoads = 0;
  const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
  const source = {
    name: "sweep", level: 1,
    async listConceptIds() { listLoads += 1; return ids; },
    async loadConcept(id) { conceptLoads += 1; return { id, sections: [] }; },
    close() {},
  };
  const cached = withCache(source, { ttlMs: 60_000, maxEntries: 3 }); // cap well under ids.length

  await cached.listConceptIds({});
  for (const id of ids) await cached.loadConcept(id);
  assert.equal(listLoads, 1, "the listing loaded once");
  assert.equal(conceptLoads, 10, "every concept loaded once, sanity check");

  // A second full sweep: the listing must still be a cache hit even though
  // ten concept reads happened after it, well past the per-source cap of 3.
  await cached.listConceptIds({});
  assert.equal(listLoads, 1, "the listing was evicted by unrelated concept reads");
});
