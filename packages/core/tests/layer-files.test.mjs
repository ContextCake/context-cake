// GET /api/files must not read a deleted layer folder as an empty one.
//
// walkAll used to swallow ENOENT on the walk root the same way it swallows an
// ordinary subdirectory vanishing mid-walk, so a layer whose folder had been
// moved or removed reported fileCount: 0 with no error — indistinguishable
// from a folder that genuinely has nothing in it. okf-local's walkDocs
// already draws this distinction for the indexer; this pins the same
// distinction for the file-browsing APIs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFilesApi } from "../src/layer-files.mjs";

test("a genuinely empty layer folder reports zero files with no error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-empty-"));
  try {
    const roots = new Map([["empty", { root, kind: "files" }]]);
    const { layers } = await listFilesApi(roots);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].fileCount, 0);
    assert.equal(layers[0].error, null, "a genuinely empty folder must not be reported as an error");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a layer whose folder was deleted reports an error instead of a silent empty folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-gone-"));
  fs.rmSync(root, { recursive: true, force: true }); // gone before the walk ever runs
  const roots = new Map([["gone", { root, kind: "files" }]]);
  const { layers } = await listFilesApi(roots);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].fileCount, 0);
  assert.deepEqual(layers[0].files, []);
  assert.match(layers[0].error ?? "", /no longer exists/, "a vanished layer folder must say so, not read as empty");
});

test("one vanished layer does not blank the listing for a healthy sibling", async () => {
  const healthyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-healthy-"));
  const goneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-gone2-"));
  fs.writeFileSync(path.join(healthyRoot, "note.md"), "# Note\n\n## Body\n\nhello.\n");
  fs.rmSync(goneRoot, { recursive: true, force: true });
  try {
    const roots = new Map([
      ["gone", { root: goneRoot, kind: "files" }],
      ["healthy", { root: healthyRoot, kind: "files" }],
    ]);
    const { layers } = await listFilesApi(roots);
    const gone = layers.find((l) => l.layer === "gone");
    const healthy = layers.find((l) => l.layer === "healthy");
    assert.ok(gone.error, "the vanished layer reports an error");
    assert.equal(healthy.fileCount, 1, "the healthy sibling still lists its file");
    assert.equal(healthy.error, null);
  } finally {
    fs.rmSync(healthyRoot, { recursive: true, force: true });
  }
});
