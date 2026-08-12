// The disk walk under vault-shaped stress: a FLAT directory (every note in
// one folder — the default Obsidian shape) must not become one uninterruptible
// unit, and the walk's entries must carry the fingerprint fields the
// incremental index's skip gate reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeDocs, walkDocEntries, walkDocs } from "../src/sources/okf-local.mjs";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-walk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("walkDocEntries carries path, rel, ext, size and mtime, sorted by path", async (t) => {
  const root = tmpdir(t);
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "b.md"), "# B\n\nbody\n");
  fs.writeFileSync(path.join(root, "sub", "a.txt"), "plain\n");
  const entries = await walkDocEntries(root, [".md", ".txt"], { maxFiles: 100, maxEntries: 100 });
  assert.deepEqual(entries.map((e) => e.rel), ["b.md", "sub/a.txt"]);
  assert.deepEqual(entries.map((e) => e.ext), [".md", ".txt"]);
  for (const entry of entries) {
    assert.ok(entry.size > 0);
    assert.ok(entry.mtimeMs > 0);
    assert.ok(path.isAbsolute(entry.path));
  }
  // The wrapper keeps its original shape: bare paths.
  const paths = await walkDocs(root, [".md", ".txt"], { maxFiles: 100, maxEntries: 100 });
  assert.deepEqual(paths, entries.map((e) => e.path));
});

test("an abort lands MID-directory in a flat vault, not only at directory boundaries", async (t) => {
  const root = tmpdir(t);
  // One flat directory, thousands of entries: the shape that used to make the
  // whole walk a single abort checkpoint.
  for (let i = 0; i < 3000; i += 1) {
    fs.writeFileSync(path.join(root, `note-${String(i).padStart(4, "0")}.md`), `# N${i}\n`);
  }
  const controller = new AbortController();
  // Abort as soon as the walk first yields the event loop — which the breath
  // interval guarantees happens while the flat directory is still being
  // processed. Before the fix this fired after the directory was done.
  setImmediate(() => controller.abort(new Error("test abort")));
  await assert.rejects(
    () => walkDocEntries(root, [".md"], { maxFiles: 10_000, maxEntries: 100_000 }, { signal: controller.signal }),
    /test abort/,
  );
});

test("probeDocs finds documents buried past thousands of attachments", async (t) => {
  const root = tmpdir(t);
  // 5,000 non-document files sort ahead of the one real note: under the old
  // 4,000-entry default the probe gave up first and the add form told the
  // user their vault held no documents.
  for (let i = 0; i < 5000; i += 1) {
    fs.writeFileSync(path.join(root, `att-${String(i).padStart(4, "0")}.png`), "x");
  }
  fs.writeFileSync(path.join(root, "zz-note.md"), "# hello\n");
  const result = await probeDocs(root, [".md"]);
  assert.equal(result.found, true);
});
