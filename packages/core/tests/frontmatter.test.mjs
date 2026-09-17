// A file saved with Windows line endings (CRLF) must parse like the same file
// saved with LF.
//
// Every frontmatter reader used to test `startsWith("---\n")`, so a CRLF file
// fell through as "no frontmatter" and silently lost its type, title, and
// `updated` date. Even past the fence, the last key kept a trailing `\r` that
// the `(.*)$` key pattern refuses, so it vanished too. CRLF reaches a layer
// whenever a teammate on Windows commits without `.gitattributes` normalizing.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { splitFrontmatter } from "../src/frontmatter.mjs";
import { parseConcept } from "../src/sources/okf-local.mjs";
import { parseDocument } from "../src/sources/files.mjs";
import { stageFrontmatterTransaction } from "../src/layer-files.mjs";

const LF = "---\ntype: decision\ntitle: Database\nupdated: 2026-09-01\n---\n\n# Database\n\n## Choice {#choice}\n\nPostgres\n";
const CRLF = LF.replaceAll("\n", "\r\n");

test("splitFrontmatter finds the same fields in LF and CRLF text", () => {
  const lf = splitFrontmatter(LF);
  const crlf = splitFrontmatter(CRLF);
  assert.equal(lf.newline, "\n");
  assert.equal(crlf.newline, "\r\n");
  assert.equal(lf.raw, "type: decision\ntitle: Database\nupdated: 2026-09-01");
  assert.equal(crlf.raw, "type: decision\r\ntitle: Database\r\nupdated: 2026-09-01", "no trailing \\r on the last field");
  assert.equal(lf.rest, "\n\n# Database\n\n## Choice {#choice}\n\nPostgres\n");
  assert.equal(crlf.rest, lf.rest.replaceAll("\n", "\r\n"));
});

test("splitFrontmatter answers null when there is no complete fence", () => {
  assert.equal(splitFrontmatter("# Just a heading\n"), null);
  assert.equal(splitFrontmatter("---\ntype: decision\n"), null, "unterminated");
  assert.equal(splitFrontmatter("---\r\ntype: decision\r\n"), null, "unterminated CRLF");
  assert.equal(splitFrontmatter("--- not a fence\n---\n"), null);
});

test("parseConcept reads a CRLF concept exactly like its LF twin", () => {
  const lf = parseConcept(LF);
  const crlf = parseConcept(CRLF);
  assert.deepEqual(crlf.frontmatter, { type: "decision", title: "Database", updated: "2026-09-01" });
  assert.deepEqual(crlf.frontmatter, lf.frontmatter);
  assert.deepEqual(crlf.sections.map((s) => [s.key, s.text]), lf.sections.map((s) => [s.key, s.text]));
});

test("a files-kind CRLF document is parsed as OKF, not as plain markdown", () => {
  const lf = parseDocument({ content: LF, stem: "database", updated: "2026-01-01" });
  const crlf = parseDocument({ content: CRLF, stem: "database", updated: "2026-01-01" });
  assert.equal(crlf.frontmatter.type, "decision");
  assert.deepEqual(crlf.frontmatter, lf.frontmatter);
});

test("a frontmatter write reads the last CRLF field and keeps the file's line endings", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-frontmatter-crlf-"));
  try {
    const root = path.join(dir, "team");
    await fsp.mkdir(root);
    const file = path.join(root, "governed.md");
    await fsp.writeFile(file, "---\r\ntype: decision\r\nowner: Platform\r\n---\r\n\r\n# Governed\r\n");
    const roots = new Map([["team", { root, kind: "okf-local" }]]);
    const staged = await stageFrontmatterTransaction(JSON.stringify({
      conceptId: "governed", key: "owner", layers: ["team"], value: "Architecture",
      expectedValues: { team: "Platform" },
    }), roots, "tx-crlf");
    await staged.commit();
    await staged.cleanup();
    assert.equal(await fsp.readFile(file, "utf8"), "---\r\ntype: decision\r\nowner: \"Architecture\"\r\n---\r\n\r\n# Governed\r\n");
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
