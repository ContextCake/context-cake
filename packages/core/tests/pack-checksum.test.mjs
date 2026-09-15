// The Pack tree checksum blanks PACK.yaml's declared checksum before hashing.
// That used a regex which rescanned a long blank run from every line start in
// it (ReDoS), on a file whoever published the Pack wrote. The regex stays here
// as the specification: a changed answer would change every Pack's checksum.

import test from "node:test";
import assert from "node:assert/strict";
import { blankDeclaredChecksum } from "../src/pack-manager.mjs";

const DECLARED_CHECKSUM = /(^\s*checksum:\s*).+$/m;
const blank = (text) => text.replace(DECLARED_CHECKSUM, "$1\"pending-release\"");

test("blankDeclaredChecksum agrees with the regex it replaced", () => {
  assert.equal(
    blankDeclaredChecksum("id: demo\nartifact:\n  checksum: sha256:abc\n  size: 3\n"),
    "id: demo\nartifact:\n  checksum: \"pending-release\"\n  size: 3\n",
  );
  // Seeded. `\s` crosses line terminators on both sides of the key, and `.+`
  // may have to start on a trailing blank, so the pieces are mostly blanks.
  const pieces = ["checksum:", "checksum", ":", " ", "\t", "\r", "\n", "\r\n", String.fromCharCode(0x2028), String.fromCharCode(0x2029), String.fromCharCode(0xa0), "a", "x: y"];
  let state = 3;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  let changed = 0;
  for (let i = 0; i < 100_000; i += 1) {
    let text = "";
    for (let length = next() % 14; length > 0; length -= 1) text += pieces[next() % pieces.length];
    const expected = blank(text);
    assert.equal(blankDeclaredChecksum(text), expected, JSON.stringify(text));
    if (expected !== text) changed += 1;
  }
  assert.ok(changed > 5_000, `too few replacements sampled: ${changed}`);
});

test("hostile PACK.yaml blank runs normalize in linear time", () => {
  const run = 200_000;
  const started = performance.now();
  assert.equal(blankDeclaredChecksum("\r".repeat(run)), "\r".repeat(run));
  // Blanks to the end of the file after the key: `.+` starts on the last one.
  assert.equal(blankDeclaredChecksum(`${" ".repeat(run)}checksum:${" ".repeat(run)}`), `${" ".repeat(run)}checksum:${" ".repeat(run - 1)}"pending-release"`);
  // Only line breaks after the key: no match at all.
  const unmatched = `${"\n".repeat(run)}checksum:${"\n".repeat(run)}`;
  assert.equal(blankDeclaredChecksum(unmatched), unmatched);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `hostile PACK.yaml took ${Math.round(elapsed)} ms`);
});
