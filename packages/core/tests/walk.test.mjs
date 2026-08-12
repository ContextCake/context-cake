// The disk walk under vault-shaped stress: a FLAT directory (every note in
// one folder — the default Obsidian shape) must not become one uninterruptible
// unit, and the walk's entries must carry the fingerprint fields the
// incremental index's skip gate reads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createOkfLocalSource, probeDocs, walkDocEntries, walkDocs } from "../src/sources/okf-local.mjs";

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

test("listEntries fingerprints the authored date, so a commit re-reads an unchanged file", async (t) => {
  // A document's date can move without the document moving: committing a note
  // gives it an authored date while leaving the bytes and the mtime alone. If
  // the fingerprint could not see that, the incremental pass would carry an
  // mtime-derived date forward forever inside a git-backed layer.
  const root = tmpdir(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "note.md"), "# Note\n\n## Body {#body}\n\nhello\n");
  const source = createOkfLocalSource({ name: "vault", level: 3, root });

  const [before] = await source.listEntries({});
  git("add", "note.md");
  git("commit", "-q", "-m", "add note");
  source.sync(); // the memo drop a live layer performs after a pull
  const [after] = await source.listEntries({});

  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs); // the file itself did not move
  assert.notEqual(before.authoredDate, after.authoredDate); // its date did
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
