// Index key/identity invariants.
//
// An index entry is keyed per layer row, and two rows sharing a key means one
// source's documents are served under the other source's name and level — a
// local folder reporting a foreign MCP server's concepts as its own, and
// winning the merge with them. That was reachable from the manifest: a layer
// field named `kind` overwrote the source kind in a flat identity object.
//
// So the property under test is not "these particular field names behave" but
// "no layer field CAN collide two rows". The adversarial names below are the
// ones that were reachable; the permutation and nesting cases are there because
// the identity is a string built from an object, and a string built from an
// object is exactly where an encoding collision hides.

import test from "node:test";
import assert from "node:assert/strict";
import { indexEntryKeys, layerIdentity } from "../src/index-keys.mjs";

const SETTINGS = { maxDocFiles: 10000, maxScanEntries: 200000, sourceBudgetMs: 30000 };

function keysFor(layers, { settings = SETTINGS, epochOf = () => 0 } = {}) {
  return indexEntryKeys(
    layers.map((layer) => ({ name: layer.name, identity: layerIdentity(layer), epoch: epochOf(layer) })),
    settings,
  );
}

function assertDistinct(layers, why) {
  const { keys, validities } = keysFor(layers);
  assert.equal(new Set(keys).size, keys.length, `${why}: index keys collided\n${keys.join("\n")}`);
  // Validity is what decides whether one row's finished entry may be carried
  // over to another (see adoptIndexes), so two rows that read different things
  // must never share one — a key that differs only by name is not enough.
  assert.equal(new Set(validities).size, validities.length, `${why}: validities collided\n${validities.join("\n")}`);
  return { keys, validities };
}

test("a layer field named kind cannot hijack another layer's index entry", () => {
  // The reported reproduction, minus the MCP child: two layers over the same
  // folder read by DIFFERENT adapters, one carrying a stray "kind" — which is
  // not a reserved layer field, and is exactly what the desktop app's settings
  // sync writes onto a synced source record. Flat identities collided, so one
  // adapter's parse of the folder was served as the other's.
  const { validities } = assertDistinct(
    [
      { name: "notes", level: 5, source: "okf-local", path: "/tmp/notes" },
      { name: "docs", level: 2, source: "files", path: "/tmp/notes", kind: "okf-local" },
    ],
    "kind field",
  );
  assert.notEqual(validities[0], validities[1], "content identities collided");
});

test("no reserved-slot name is reachable from a layer field", () => {
  // Every name the identity encoding uses for its own structure, each paired
  // with the layer it would be impersonating.
  const cases = [
    [{ name: "a", source: "files", path: "/p", kind: "okf-local" }, { name: "b", source: "okf-local", path: "/p" }],
    [{ name: "a", source: "files", path: "/p", fields: { path: "/p" } }, { name: "b", source: "files", path: "/p" }],
    [{ name: "a", source: "files", path: "/p", identity: "x" }, { name: "b", source: "files", path: "/p" }],
    [{ name: "a", source: "files", path: "/p", validity: "x" }, { name: "b", source: "files", path: "/p" }],
    [{ name: "a", source: "mcp", command: "x", kind: "mcp" }, { name: "b", source: "mcp", command: "x" }],
  ];
  for (const [x, y] of cases) {
    const field = Object.keys(x).at(-1);
    const { validities } = assertDistinct([x, y], `field ${field}`);
    assert.notEqual(validities[0], validities[1], `${field} collided with a real layer`);
  }
});

test("__proto__ is stored, not swallowed", () => {
  // Plain assignment into a plain object sets the prototype instead of an own
  // property, so two layers differing only here would produce one identity.
  const a = { name: "a", source: "files", path: "/p" };
  const b = { name: "b", source: "files", path: "/p" };
  Object.defineProperty(a, "__proto__", { value: { evil: true }, enumerable: true, configurable: true });
  Object.defineProperty(b, "__proto__", { value: { evil: false }, enumerable: true, configurable: true });
  assert.notEqual(layerIdentity(a), layerIdentity(b), "__proto__ vanished from the identity");
  assertDistinct([a, b], "__proto__");
});

test("field order does not change a layer's identity", () => {
  const one = { name: "a", level: 2, source: "github", repo: "o/r", ref: "main", paths: ["docs/**"] };
  const other = { paths: ["docs/**"], ref: "main", repo: "o/r", source: "github", level: 2, name: "a" };
  assert.equal(layerIdentity(one), layerIdentity(other));
});

test("nested field shapes are distinguished, not flattened into one string", () => {
  const a = { name: "a", source: "files", path: "/p", cache: { ttlSeconds: 900, dir: "x" } };
  const b = { name: "b", source: "files", path: "/p", cache: { ttlSeconds: 900, dir: "y" } };
  const c = { name: "c", source: "files", path: "/p", cache: { ttlSeconds: "900,dir:x" } };
  assertDistinct([a, b, c], "nested cache blocks");
});

test("name and level stay out of the identity but the key is still per row", () => {
  // Two rows over the same folder: same content identity (so one is a valid
  // index of the other's content) but never one shared entry.
  const layers = [
    { name: "one", level: 1, source: "files", path: "/p" },
    { name: "two", level: 9, source: "files", path: "/p" },
  ];
  const { keys, validities } = keysFor(layers);
  assert.equal(validities[0], validities[1], "identical config should share a validity");
  assert.notEqual(keys[0], keys[1], "two rows shared one index entry");
  // Re-levelling must not re-key. A RENAME does re-key, by design — the name is
  // in the key so two rows over one folder never share an entry — and what
  // keeps a settled 3,000-note vault from re-reading every file is adoptIndexes
  // moving the entry to the new key, because the validity is unchanged.
  const releveled = keysFor([{ ...layers[0], name: "one", level: 4 }]);
  assert.equal(releveled.keys[0], keys[0], "changing level re-keyed the entry");
});

test("byte-identical rows still get one entry each", () => {
  const layer = { name: "same", level: 1, source: "files", path: "/p" };
  const { keys } = keysFor([layer, { ...layer }, { ...layer }]);
  assert.equal(new Set(keys).size, 3);
});

test("policy is part of the key: settings and credential epoch re-key", () => {
  const layers = [{ name: "gh", level: 2, source: "github", repo: "o/r", auth: "keychain:work" }];
  const base = keysFor(layers).keys[0];
  const lowered = keysFor(layers, { settings: { ...SETTINGS, maxDocFiles: 100 } }).keys[0];
  const reauthed = keysFor(layers, { epochOf: () => 1 }).keys[0];
  assert.notEqual(base, lowered, "a settings change must re-key");
  assert.notEqual(base, reauthed, "a credential change must re-key");
  assert.notEqual(lowered, reauthed);
});

test("a quarantined row's identity is distinct per row and stable per rebuild", () => {
  // Quarantined layers reach indexEntryKeys with the complaint as identity.
  const rows = [
    { name: "bad-a", identity: '{"error":"boom","quarantined":"bad-a"}' },
    { name: "bad-b", identity: '{"error":"boom","quarantined":"bad-b"}' },
  ];
  const first = indexEntryKeys(rows, SETTINGS);
  const second = indexEntryKeys(rows, SETTINGS);
  assert.deepEqual(first.keys, second.keys);
  assert.equal(new Set(first.keys).size, 2);
});

test("a thousand generated layers never collide", () => {
  // Cheap fuzz over the shapes a manifest can hold, including the field names
  // the encoding uses for itself.
  const names = ["kind", "fields", "path", "repo", "command", "cache", "git", "live", "origin", "__proto__"];
  const layers = [];
  for (let i = 0; i < 1000; i += 1) {
    const layer = { name: `layer-${i}`, level: i % 7, source: ["okf-local", "files", "github", "mcp"][i % 4] };
    for (let f = 0; f <= i % 4; f += 1) {
      const field = names[(i + f) % names.length];
      const value = [`v${i}`, i, { nested: i }, [i, `v${f}`], null, true][(i + f) % 6];
      Object.defineProperty(layer, field, { value, enumerable: true, configurable: true });
    }
    layers.push(layer);
  }
  const { keys } = keysFor(layers);
  assert.equal(new Set(keys).size, layers.length);
});
