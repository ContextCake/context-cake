// The capture scanner's JWT check replaced a regex that rescanned a long token
// run from every "eyJ" inside it (polynomial ReDoS). The regex stays here as
// the specification: the check must reject exactly what it rejected.

import test from "node:test";
import assert from "node:assert/strict";
import { scanForCredentials } from "../src/capture.mjs";

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

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
