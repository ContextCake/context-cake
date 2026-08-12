// When a pass may hand back the PREVIOUS snapshot object instead of its own.
//
// The reuse is what keeps the memos warm across a pass that changed nothing,
// so it has to be exactly as narrow as "nothing changed". The clause worth a
// test of its own is the retry seed: a document carried from an aborted
// predecessor is content the served snapshot does NOT have, and reusing the
// old object there drops an edit silently — the snapshot then disagrees with
// disk, so nothing re-reads it until an unrelated change or a restart.
import test from "node:test";
import assert from "node:assert/strict";
import { canReuseSnapshot } from "../src/service.mjs";

const NO_NOTES = { skipped: [], unreadable: [], hidden: 0 };
const snap = (ids) => ({ ids, skipped: [], unreadable: [], hidden: 0, truncated: null });
const call = (previous, over) => canReuseSnapshot(previous, {
  stats: { carried: over.carried ?? 0, read: over.read ?? 0, tokenized: 0, removed: over.removed ?? 0 },
  carriedFromSeed: over.carriedFromSeed ?? 0,
  idCount: over.idCount ?? previous?.ids.length ?? 0,
  notes: over.notes ?? NO_NOTES,
});

test("a pass that read nothing and lost nothing reuses the snapshot", () => {
  assert.equal(call(snap(["a", "b"]), { carried: 2 }), true);
});

test("a first pass has nothing to reuse", () => {
  assert.equal(call(null, { read: 2 }), false);
});

test("any read, removal or count change forces a fresh snapshot", () => {
  const previous = snap(["a", "b"]);
  assert.equal(call(previous, { carried: 1, read: 1 }), false);
  assert.equal(call(previous, { carried: 2, removed: 1 }), false);
  assert.equal(call(previous, { carried: 3, idCount: 3 }), false);
});

test("a warning that appeared or cleared forces a fresh snapshot", () => {
  const previous = snap(["a"]);
  assert.equal(call(previous, { carried: 1, notes: { ...NO_NOTES, hidden: 4 } }), false);
  assert.equal(call(previous, {
    carried: 1, notes: { skipped: [{ rel: "big.md", bytes: 9 }], unreadable: [], hidden: 0 },
  }), false);
  assert.equal(call(previous, { carried: 1, notes: { ...NO_NOTES, truncated: { cap: 25000 } } }), false);
});

test("a carry from the retry seed is newer content, not a quiet pass", () => {
  // The regression: an aborted pass had already read an edited note, so this
  // pass reads nothing and still holds content the previous snapshot lacks.
  assert.equal(call(snap(["a", "b"]), { carried: 2, carriedFromSeed: 1 }), false);
});
