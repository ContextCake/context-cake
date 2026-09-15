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

test("the markup check answers exactly as the regex it replaced, in linear time", () => {
  // The old regex, as the specification. Its link and tag branches rescanned
  // to the end from every "[" or "<a" in a long run (ReDoS).
  const MARKUP = /```|~~~|`|!?\[[^\]]*\]\(|<\/?[a-z][^>]*>|https?:\/\/|\|[^\n]*\|/i;
  const REASON = "The answers use the same words in the same order; only formatting differs.";
  // Seeded. Every value ends in a word, so only the markup check can make it null.
  const pieces = ["[", "]", "(", "!", "<", ">", "/", "a", "Z", "|", "\n", "`", "~", "~~", "http", "HTTPS", "://", ":/", " ", String.fromCharCode(0x212a)];
  let state = 9;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  const seen = { true: 0, false: 0 };
  for (let i = 0; i < 50_000; i += 1) {
    let value = "";
    for (let length = next() % 12; length > 0; length -= 1) value += pieces[next() % pieces.length];
    value += " word";
    const markup = MARKUP.test(value);
    assert.equal(trivialConflictReason([value, value]), markup ? null : REASON, JSON.stringify(value));
    seen[markup] += 1;
  }
  assert.ok(seen.true > 1_000 && seen.false > 1_000, `unbalanced sample: ${JSON.stringify(seen)}`);

  const started = performance.now();
  for (const run of ["[".repeat(200_000), "<a".repeat(100_000)]) {
    // Unclosed, the run is only punctuation; closed at the very end, it is a link or a tag.
    assert.equal(trivialConflictReason([`${run} word`, "word"]), run.startsWith("[") ? REASON : null);
    assert.equal(trivialConflictReason([`${run}${run.startsWith("[") ? "](x)" : ">"} word`, "word"]), null);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `hostile conflict values took ${Math.round(elapsed)} ms`);
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
