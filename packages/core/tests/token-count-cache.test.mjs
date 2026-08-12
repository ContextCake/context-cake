// token-count-cache.mjs: the persistent BPE count cache. The properties that
// matter are durability-shaped: torn lines cost an entry and nothing else, a
// header mismatch rotates the file instead of serving wrong-function counts,
// concurrent writers cannot corrupt reads, and compaction keeps the live set.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTokenCountCache, hashTokenText } from "../src/token-count-cache.mjs";

function tmpfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tokcache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "token-counts.v1.ndjson");
}

test("round-trips counts across instances (the restart case)", async (t) => {
  const file = tmpfile(t);
  const first = createTokenCountCache({ file, tokenizer: "o200k_base" });
  const h = first.hash("some section text");
  assert.equal(first.get(h), undefined);
  first.put(h, 42);
  assert.equal(first.get(h), 42, "hit in-memory before any flush");
  await first.flush();

  const second = createTokenCountCache({ file, tokenizer: "o200k_base" });
  assert.equal(second.get(h), 42, "a fresh process reads the landed count");
});

test("torn and garbage lines cost entries, never the file", async (t) => {
  const file = tmpfile(t);
  const cache = createTokenCountCache({ file, tokenizer: "o200k_base" });
  cache.put(cache.hash("a"), 1);
  cache.put(cache.hash("b"), 2);
  await cache.flush();
  fs.appendFileSync(file, '{"h":"torn-lin'); // a crash mid-append
  fs.appendFileSync(file, "\nnot json at all\n");

  const reread = createTokenCountCache({ file, tokenizer: "o200k_base" });
  assert.equal(reread.get(cache.hash("a")), 1);
  assert.equal(reread.get(cache.hash("b")), 2);
});

test("a tokenizer change rotates the file aside instead of serving stale counts", async (t) => {
  const file = tmpfile(t);
  const old = createTokenCountCache({ file, tokenizer: "cl100k_base" });
  old.put(old.hash("text"), 99);
  await old.flush();

  const next = createTokenCountCache({ file, tokenizer: "o200k_base" });
  assert.equal(next.get(hashTokenText("cl100k_base", "text")), undefined);
  assert.ok(fs.existsSync(`${file}.superseded`), "the old file is kept aside, not deleted");
});

test("duplicate puts do not grow the pending queue and last write wins on disk", async (t) => {
  const file = tmpfile(t);
  const cache = createTokenCountCache({ file, tokenizer: "o200k_base" });
  const h = cache.hash("dup");
  cache.put(h, 7);
  cache.put(h, 7);
  cache.put(h, 7);
  await cache.flush();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "header + exactly one entry");
});

test("two writers interleave without corrupting either's entries", async (t) => {
  const file = tmpfile(t);
  const a = createTokenCountCache({ file, tokenizer: "o200k_base" });
  const b = createTokenCountCache({ file, tokenizer: "o200k_base" });
  for (let i = 0; i < 50; i += 1) {
    a.put(a.hash(`a-${i}`), i);
    b.put(b.hash(`b-${i}`), i * 10);
  }
  await Promise.all([a.flush(), b.flush()]);

  const reader = createTokenCountCache({ file, tokenizer: "o200k_base" });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(reader.get(reader.hash(`a-${i}`)), i);
    assert.equal(reader.get(reader.hash(`b-${i}`)), i * 10);
  }
});
