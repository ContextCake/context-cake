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
