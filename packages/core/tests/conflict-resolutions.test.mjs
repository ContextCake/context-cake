import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConflictResolutionLog, trivialConflictReason } from "../src/conflict-resolutions.mjs";

test("format-only prose is safe when its tokens stay in the same order", () => {
  assert.equal(
    trivialConflictReason(["Use **Postgres** for writes.", "Use postgres for writes"]),
    "The answers use the same words in the same order; only formatting differs.",
  );
  assert.equal(trivialConflictReason(["Deploy after tests.", "Test after deploy."]), null);
  assert.equal(trivialConflictReason(["Retry 3 times.", "Retry 4 times."]), null);
});

test("code, links, and tables always require a person", () => {
  assert.equal(trivialConflictReason(["Run `npm test`.", "Run npm test."]), null);
  assert.equal(trivialConflictReason(["Read [the guide](./guide.md).", "Read the guide."]), null);
  assert.equal(trivialConflictReason(["| A | B |", "A B"]), null);
});

test("the local log appends records and refuses malformed history", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-resolutions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = createConflictResolutionLog(path.join(dir, "manifest.json"));
  const saved = await log.append({ id: "r1", conflictId: "c::s" });
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(await log.list(), [saved]);
  assert.equal((await log.find("r1")).conflictId, "c::s");

  await fs.appendFile(log.file, "not-json\n");
  await assert.rejects(log.list(), /unreadable at line 2/);
});
