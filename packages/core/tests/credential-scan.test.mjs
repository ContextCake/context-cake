// Capture's JWT check and its frontmatter line-break flattening replaced
// regexes that backtracked polynomially on long runs (ReDoS). The regexes stay
// here as the specification: the replacements must answer exactly as they did.

import test from "node:test";
import assert from "node:assert/strict";
import { renderCapture, scanForCredentials } from "../src/capture.mjs";

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const LINE_BREAK_RUN = /\s*[\r\n]+\s*/g;

test("the capture JWT check rejects exactly what its old regex did, in linear time", () => {
  // Seeded near-misses around the ten-character minimums and the "eyJ"
  // position. No other credential pattern can fire on these pieces, so the
  // scan answers for the JWT check alone.
  let state = 5;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  const pick = (list) => list[next() % list.length];
  const segments = ["", "a", "aaaaaaaaa", "aaaaaaaaaa", "eyJ", "eyJaaaaaaaaa", "eyJaaaaaaaaaa", "x-eyJaaaaaaaaaa", "eyJaaaaaaaaaaeyJ", "!aaaaaaaaaa", "aaaaaaaaaa!"];
  const joins = [".", ".", ".", "-", "!"];
  const seen = { true: 0, false: 0 };
  for (let i = 0; i < 50_000; i += 1) {
    let value = pick(segments);
    for (let parts = 1 + (next() % 4); parts > 0; parts -= 1) value += pick(joins) + pick(segments);
    const expected = JWT.test(value);
    assert.equal(scanForCredentials(value), expected, JSON.stringify(value));
    seen[expected] += 1;
  }
  assert.ok(seen.true > 1_000 && seen.false > 1_000, `unbalanced sample: ${JSON.stringify(seen)}`);

  assert.equal(scanForCredentials("Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl"), true);
  const started = performance.now();
  assert.equal(scanForCredentials("eyJ".repeat(300_000)), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `a hostile capture field took ${Math.round(elapsed)} ms`);
});

test("capture frontmatter flattens line breaks exactly as its old regex did, in linear time", () => {
  const flat = (text) => text.replace(LINE_BREAK_RUN, " ");
  // fmValue's quoting, unchanged, so the rendered line can be compared whole.
  const frontmatter = (text) => {
    const value = flat(text).trim();
    return /[:#]|^['"\s]|['"\s]$/.test(value) ? `"${value}"` : value;
  };
  // Seeded. Every kind of blank, with and without a line break in the run.
  const pieces = [" ", "\t", "\r", "\n", "\v", String.fromCharCode(0x2028), String.fromCharCode(0xa0), String.fromCharCode(0xfeff), "a", ":", "'"];
  let state = 7;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  for (let i = 0; i < 50_000; i += 1) {
    let value = "";
    for (let length = next() % 16; length > 0; length -= 1) value += pieces[next() % pieces.length];
    const lines = renderCapture({ kind: "gotcha", title: value, sections: {} }, { author: value, capturedAt: "t" }).split("\n");
    assert.deepEqual(
      [lines[2], lines[3], lines[8]],
      [`title: ${frontmatter(value)}`, `author: ${frontmatter(value)}`, `# ${flat(value)}`],
      JSON.stringify(value),
    );
  }

  const started = performance.now();
  // A blank run with no line break is what the old pattern rescanned.
  const rendered = renderCapture({ kind: "gotcha", title: `${"\t".repeat(200_000)}x`, sections: {} }, { author: `a${" ".repeat(200_000)}b`, capturedAt: "t" });
  const elapsed = performance.now() - started;
  assert.ok(rendered.includes("title: x"));
  assert.ok(elapsed < 5_000, `a hostile capture title took ${Math.round(elapsed)} ms`);
});
