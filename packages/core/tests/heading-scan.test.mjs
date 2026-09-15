// Heading and attr-group scanning replaced three regexes that could backtrack
// for minutes on one hostile line (CodeQL js/polynomial-redos). The regexes
// stay here as the specification: the scanners must agree with them on every
// input, and only be faster.

import test from "node:test";
import assert from "node:assert/strict";
import { findAttrGroup, matchHeadingLine, parseConcept, stripAttrGroups } from "../src/sources/okf-local.mjs";
import { parseDocument } from "../src/sources/files.mjs";
import { readSectionBody, replaceSection } from "../src/layer-files.mjs";

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const ATTR_GROUP = /\{([^}]*)\}/;

// Seeded, so a failure reproduces. Short strings over the characters that sit
// on the edges: heading marks, every kind of whitespace, line terminators the
// line split leaves behind, braces.
function* randomLines(count, seed) {
  const alphabet = ["#", " ", " ", "\t", "\r", "\n", "\u2028", "\u00a0", "\ufeff", "{", "}", "{", "a", "Z", "="];
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  for (let i = 0; i < count; i += 1) {
    let line = next() % 2 ? "#".repeat(1 + (next() % 7)) : "";
    for (let length = next() % 12; length > 0; length -= 1) line += alphabet[next() % alphabet.length];
    yield line;
  }
}

test("matchHeadingLine agrees with the heading regex it replaced", () => {
  for (const line of randomLines(100_000, 1)) {
    const expected = line.match(HEADING);
    const actual = matchHeadingLine(line);
    if (!expected) {
      assert.equal(actual, null, JSON.stringify(line));
      continue;
    }
    assert.equal(actual?.level, expected[1].length, JSON.stringify(line));
    // A whitespace-only heading captured one whitespace character. Every
    // caller trims it away, so the scanner reports "".
    assert.equal(actual.text, expected[2].trim(), JSON.stringify(line));
  }
});

test("findAttrGroup and stripAttrGroups agree with the brace regexes they replaced", () => {
  for (const text of randomLines(100_000, 2)) {
    const expected = text.match(ATTR_GROUP);
    const group = findAttrGroup(text);
    assert.deepEqual(group && [group.start, group.inner], expected && [expected.index, expected[1]], JSON.stringify(text));
    assert.equal(stripAttrGroups(text), text.replace(/\{[^}]*\}/g, ""), JSON.stringify(text));
  }
});

test("hostile heading lines parse in linear time", () => {
  const spaces = " ".repeat(200_000);
  // Under the old regexes the first line took hours and the second tens of
  // seconds; the body's trailing-whitespace strip was quadratic too.
  const text = ["# target", `#${spaces}x\ry`, `## ${"{".repeat(200_000)}`].join("\n");
  const started = performance.now();
  parseConcept(text);
  parseDocument({ content: text, stem: "hostile", updated: null });
  readSectionBody(text, "target");
  assert.equal(replaceSection(text, "target", `${spaces}x`).replaced, true);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `hostile headings took ${Math.round(elapsed)} ms`);
});
