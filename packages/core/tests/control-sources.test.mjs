// Cascade order through the source control operations: the pure level
// assignment, the reorder op, `position` on add, and the `level` validation
// on add/patch. Runs against real temp manifests through createSourceOperations
// (no HTTP) — the service-test.sh suite covers the PUT /api/sources/order
// adapter over the same operations.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assignCascadeLevels,
  createSourceOperations,
  parseLevel,
  syncPackAssignmentLevel,
} from "../src/control/sources.mjs";
import { readContextManifest, readContextManifestQuarantined } from "../src/manifest.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-control-sources-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A manifest with `layers` (legacy shape unless `v2`), each layer a real
// folder so the add/patch probes have something to stat.
function writeManifest(dir, layers, { v2 = false, packs } = {}) {
  for (const layer of layers) {
    if (typeof layer.path === "string" && !layer.origin?.startsWith("pack:")) {
      fs.mkdirSync(path.resolve(dir, layer.path), { recursive: true });
    }
  }
  const manifest = v2
    ? { profiles: { default: { label: "Default", layers } }, ...(packs ? { packs } : {}) }
    : { layers, ...(packs ? { packs } : {}) };
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function levelsOf(manifestPath) {
  const manifest = readContextManifest(manifestPath, { allowMissing: false });
  const layers = manifest.layers ?? manifest.profiles.default.layers;
  return Object.fromEntries(layers.map((layer) => [layer.name, layer.level]));
}

function folderLayer(dir, name, level, extra = {}) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  return { name, level, source: "files", path: path.join(dir, name), ...extra };
}

async function rejects(promiseOrFn, code, status) {
  let error;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected a ${code} error`);
  assert.equal(error.code, code, `code (${error.message})`);
  assert.equal(error.status, status, `status (${error.message})`);
  return error;
}

// ---- parseLevel ------------------------------------------------------------

test("parseLevel accepts safe integers as numbers or numeric strings and nothing else", () => {
  assert.equal(parseLevel(3), 3);
  assert.equal(parseLevel(0), 0);
  assert.equal(parseLevel(-2), -2);
  assert.equal(parseLevel("3"), 3);
  assert.equal(parseLevel(" 7 "), 7);
  assert.equal(parseLevel("-1"), -1);
  for (const bad of [null, undefined, "", "   ", "abc", 1.5, "1.5", NaN, Infinity, true, {}, [], 2 ** 53]) {
    assert.equal(parseLevel(bad), null, `parseLevel(${JSON.stringify(bad)}) should be null`);
  }
});

// ---- assignCascadeLevels ---------------------------------------------------

test("assignCascadeLevels reuses N distinct levels as a permutation (round-trip stable)", () => {
  const personal = { name: "personal", level: 3 };
  const team = { name: "team", level: 2 };
  const company = { name: "company", level: 0 };
  // Same order → same numbers.
  assert.deepEqual(assignCascadeLevels([personal, team, company]), [
    { name: "personal", level: 3 }, { name: "team", level: 2 }, { name: "company", level: 0 },
  ]);
  // Team above personal → still a permutation of {3, 2, 0}.
  assert.deepEqual(assignCascadeLevels([team, personal, company]), [
    { name: "team", level: 3 }, { name: "personal", level: 2 }, { name: "company", level: 0 },
  ]);
  // Company to the top.
  assert.deepEqual(assignCascadeLevels([company, personal, team]), [
    { name: "company", level: 3 }, { name: "personal", level: 2 }, { name: "team", level: 0 },
  ]);
  // Input untouched.
  assert.equal(personal.level, 3);
  assert.equal(team.level, 2);
  assert.equal(company.level, 0);
});

test("assignCascadeLevels renumbers N..1 on ties or an insert", () => {
  // 2/2/0 — a tie is the absence of an order; nothing to preserve.
  assert.deepEqual(assignCascadeLevels([{ name: "a", level: 2 }, { name: "b", level: 2 }, { name: "c", level: 0 }]), [
    { name: "a", level: 3 }, { name: "b", level: 2 }, { name: "c", level: 1 },
  ]);
  // An insert onto 3/2/0: the newcomer has no level, so the pool is short by one.
  assert.deepEqual(assignCascadeLevels([
    { name: "personal", level: 3 }, { name: "new", level: null }, { name: "team", level: 2 }, { name: "company", level: 0 },
  ]), [
    { name: "personal", level: 4 }, { name: "new", level: 3 }, { name: "team", level: 2 }, { name: "company", level: 1 },
  ]);
  // Numeric-string levels a hand-authored manifest may carry still count as existing.
  assert.deepEqual(assignCascadeLevels([{ name: "a", level: "3" }, { name: "b", level: "0" }]), [
    { name: "a", level: 3 }, { name: "b", level: 0 },
  ]);
  // Degenerate inputs.
  assert.deepEqual(assignCascadeLevels([]), []);
  assert.deepEqual(assignCascadeLevels([{ name: "only", level: 5 }]), [{ name: "only", level: 5 }]);
  assert.deepEqual(assignCascadeLevels([{ name: "only" }]), [{ name: "only", level: 1 }]);
});

// ---- syncPackAssignmentLevel ----------------------------------------------

test("syncPackAssignmentLevel moves the default-profile assignment with the layer, legacy and v2 keys alike", () => {
  const legacy = {
    layers: [{ name: "pack-demo", level: 4, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" }],
    packs: { demo: { installedVersions: [{ version: "1.0.0" }], assignments: [
      { profile: null, layerName: "pack-demo", activeVersion: "1.0.0", level: 0 },
      { profile: "work", layerName: "pack-demo", activeVersion: "1.0.0", level: 9 },
    ] } },
  };
  assert.equal(syncPackAssignmentLevel(legacy, legacy.layers[0]), true);
  assert.equal(legacy.packs.demo.assignments[0].level, 4);
  assert.equal(legacy.packs.demo.assignments[1].level, 9, "another profile's assignment is not this operation's business");

  const v2 = {
    profiles: { default: { label: "Default", layers: [{ name: "pack-demo", level: 2, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" }] } },
    packs: { demo: { installedVersions: [{ version: "1.0.0" }], assignments: [{ profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }] } },
  };
  assert.equal(syncPackAssignmentLevel(v2, v2.profiles.default.layers[0]), true);
  assert.equal(v2.packs.demo.assignments[0].level, 2);

  // Not a pack layer, or no assignment to move: a no-op that says so.
  assert.equal(syncPackAssignmentLevel(v2, { name: "plain", level: 1, path: "x" }), false);
  assert.equal(syncPackAssignmentLevel({ layers: [] }, { name: "pack-x", level: 1, origin: "pack:x@1.0.0" }), false);
});

// ---- reorderSources --------------------------------------------------------

test("reorderSources permutes existing distinct levels, reports the order, and never touches array order", (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "personal", 3),
    folderLayer(dir, "team", 2),
    folderLayer(dir, "company", 0),
  ]);
  const ops = createSourceOperations({ manifestPath });
  const result = ops.reorderSources({ order: ["team", "personal", "company"] });
  assert.deepEqual(result, { ok: true, order: [{ name: "team", level: 3 }, { name: "personal", level: 2 }, { name: "company", level: 0 }] });
  assert.deepEqual(levelsOf(manifestPath), { personal: 2, team: 3, company: 0 });
  // The layers array keeps its written order; only the numbers moved.
  assert.deepEqual(readContextManifest(manifestPath).layers.map((layer) => layer.name), ["personal", "team", "company"]);
  // Round trip: putting it back restores 3/2/0 exactly.
  ops.reorderSources({ order: ["personal", "team", "company"] });
  assert.deepEqual(levelsOf(manifestPath), { personal: 3, team: 2, company: 0 });
});

test("reorderSources renumbers N..1 when levels are tied", (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "a", 2),
    folderLayer(dir, "b", 2),
    folderLayer(dir, "c", 0),
  ], { v2: true });
  const ops = createSourceOperations({ manifestPath });
  const result = ops.reorderSources({ order: ["b", "a", "c"] });
  assert.deepEqual(result.order, [{ name: "b", level: 3 }, { name: "a", level: 2 }, { name: "c", level: 1 }]);
  assert.deepEqual(levelsOf(manifestPath), { a: 2, b: 3, c: 1 });
});

test("reorderSources refuses a bad order with ORDER_INVALID and says which names are wrong", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [folderLayer(dir, "a", 2), folderLayer(dir, "b", 1)]);
  const ops = createSourceOperations({ manifestPath });
  const before = fs.readFileSync(manifestPath, "utf8");

  for (const body of [{}, { order: null }, { order: "a,b" }, { order: ["a", 2] }, { order: ["a", ""] }]) {
    const error = await rejects(() => ops.reorderSources(body), "ORDER_INVALID", 400);
    assert.deepEqual(error.detail, { unknown: [], missing: [], duplicate: [] });
  }
  // An empty order is not a shape error — it is an order that names nothing,
  // so every source in the profile is missing from it.
  const empty = await rejects(() => ops.reorderSources({ order: [] }), "ORDER_INVALID", 400);
  assert.deepEqual(empty.detail, { unknown: [], missing: ["a", "b"], duplicate: [] });
  const dup = await rejects(() => ops.reorderSources({ order: ["a", "b", "a"] }), "ORDER_INVALID", 400);
  assert.deepEqual(dup.detail, { unknown: [], missing: [], duplicate: ["a"] });
  const unknown = await rejects(() => ops.reorderSources({ order: ["a", "b", "ghost"] }), "ORDER_INVALID", 400);
  assert.deepEqual(unknown.detail, { unknown: ["ghost"], missing: [], duplicate: [] });
  const missing = await rejects(() => ops.reorderSources({ order: ["a"] }), "ORDER_INVALID", 400);
  assert.deepEqual(missing.detail, { unknown: [], missing: ["b"], duplicate: [] });
  const both = await rejects(() => ops.reorderSources({ order: ["ghost", "b"] }), "ORDER_INVALID", 400);
  assert.deepEqual(both.detail, { unknown: ["ghost"], missing: ["a"], duplicate: [] });

  assert.equal(fs.readFileSync(manifestPath, "utf8"), before, "a refused reorder writes nothing");
});

test("reorderSources answers REORDER_BLOCKED (409) while a quarantined layer exists, listing it", async (t) => {
  const dir = tempDir(t);
  const seed = folderLayer(dir, "seed", 1);
  const manifestPath = writeManifest(dir, [
    seed,
    { name: "bad-kind", level: 2, source: "notarealkind" },
    { name: "seed", level: 9, source: "alsonotreal" },
  ]);
  const { quarantined } = readContextManifestQuarantined(manifestPath);
  assert.equal(quarantined.length, 2, "fixture must actually quarantine two rows");
  const ops = createSourceOperations({ manifestPath });
  const before = fs.readFileSync(manifestPath, "utf8");
  const error = await rejects(() => ops.reorderSources({ order: ["seed"] }), "REORDER_BLOCKED", 409);
  assert.match(error.message, /2 sources are invalid/);
  assert.match(error.message, /"bad-kind"/);
  assert.match(error.message, /"seed \(2\)"/);
  assert.deepEqual(error.detail.blocking.map((entry) => entry.name), ["bad-kind", "seed (2)"]);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before, "a blocked reorder writes nothing");
});

test("reorderSources answers MANIFEST_INVALID (409), never a raw 500, when the manifest is broken outside the default profile", async (t) => {
  const dir = tempDir(t);
  const before = [];

  // A bad layer in ANOTHER profile: the default profile is clean, so nothing is
  // quarantined for it, but the strict write must still refuse the manifest.
  const otherProfile = path.join(dir, "other.json");
  fs.mkdirSync(path.join(dir, "seed"), { recursive: true });
  fs.writeFileSync(otherProfile, JSON.stringify({
    profiles: {
      default: { label: "Default", layers: [{ name: "a", level: 2, source: "files", path: path.join(dir, "seed") }, { name: "b", level: 1, source: "files", path: path.join(dir, "seed") }] },
      work: { label: "Work", layers: [{ name: "w", level: 1, source: "notarealkind" }] },
    },
  }));
  before.push(fs.readFileSync(otherProfile, "utf8"));
  const other = await rejects(() => createSourceOperations({ manifestPath: otherProfile }).reorderSources({ order: ["b", "a"] }), "MANIFEST_INVALID", 409);
  assert.match(other.message, /unsupported source kind/);

  // Whole-manifest failure no single layer explains (duplicate names): the
  // tolerant read cannot quarantine, so the engine's own message rides the 409.
  const dupNames = path.join(dir, "dup.json");
  fs.writeFileSync(dupNames, JSON.stringify({ layers: [
    { name: "same", level: 2, source: "files", path: path.join(dir, "seed") },
    { name: "same", level: 1, source: "files", path: path.join(dir, "seed") },
  ] }));
  before.push(fs.readFileSync(dupNames, "utf8"));
  const dup = await rejects(() => createSourceOperations({ manifestPath: dupNames }).reorderSources({ order: ["same"] }), "MANIFEST_INVALID", 409);
  assert.match(dup.message, /duplicate layer name/);

  // A `null` body is a bad order, not a TypeError.
  const clean = writeManifest(dir, [folderLayer(dir, "x", 1)]);
  await rejects(() => createSourceOperations({ manifestPath: clean }).reorderSources(null), "ORDER_INVALID", 400);
  await rejects(() => createSourceOperations({ manifestPath: clean }).reorderSources(undefined), "ORDER_INVALID", 400);

  assert.deepEqual([fs.readFileSync(otherProfile, "utf8"), fs.readFileSync(dupNames, "utf8")], before, "nothing was written");
});

test("reorderSources keeps a Pack layer's registry assignment in step so the strict write accepts it", (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "personal", 3),
    { name: "pack-demo", level: 0, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" },
    folderLayer(dir, "team", 2),
  ], {
    v2: true,
    packs: { demo: {
      installedVersions: [{ version: "1.0.0", checksum: "sha256:test" }],
      assignments: [{ profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
    } },
  });
  const ops = createSourceOperations({ manifestPath });
  const result = ops.reorderSources({ order: ["pack-demo", "personal", "team"] });
  assert.deepEqual(result.order, [{ name: "pack-demo", level: 3 }, { name: "personal", level: 2 }, { name: "team", level: 0 }]);
  const manifest = readContextManifest(manifestPath, { allowMissing: false }); // strict read: no pack-layer-drift
  assert.equal(manifest.profiles.default.layers.find((layer) => layer.name === "pack-demo").level, 3);
  assert.equal(manifest.packs.demo.assignments[0].level, 3);
});

// ---- addSource: level / position ---------------------------------------------

test("addSource still defaults level to 1 and rejects a present-but-invalid level with LEVEL_INVALID", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [folderLayer(dir, "a", 3)]);
  fs.mkdirSync(path.join(dir, "new"));
  const ops = createSourceOperations({ manifestPath });

  const added = await ops.addSource({ kind: "files", name: "defaulted", path: path.join(dir, "new") });
  assert.equal(added.level, 1);
  assert.equal(levelsOf(manifestPath).defaulted, 1);

  for (const level of [null, "abc", 1.5, "", true]) {
    await rejects(() => ops.addSource({ kind: "files", name: "bad", path: path.join(dir, "new"), level }), "LEVEL_INVALID", 400);
  }
  assert.equal(levelsOf(manifestPath).bad, undefined);
  // A numeric string is fine — hand-written clients send those.
  const stringy = await ops.addSource({ kind: "files", name: "stringy", path: path.join(dir, "new"), level: "5" });
  assert.equal(stringy.level, 5);
  assert.equal(levelsOf(manifestPath).stringy, 5);
});

test("addSource with position inserts into the cascade and renumbers N..1; level and position together are refused", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "personal", 3),
    folderLayer(dir, "team", 2),
    folderLayer(dir, "company", 0),
  ]);
  fs.mkdirSync(path.join(dir, "new"));
  const ops = createSourceOperations({ manifestPath });

  await rejects(() => ops.addSource({ kind: "files", name: "x", path: path.join(dir, "new"), level: 1, position: 1 }), "LEVEL_AND_POSITION", 400);
  for (const position of [0, -1, "top", 1.5, null]) {
    await rejects(() => ops.addSource({ kind: "files", name: "x", path: path.join(dir, "new"), position }), "POSITION_INVALID", 400);
  }
  assert.deepEqual(levelsOf(manifestPath), { personal: 3, team: 2, company: 0 }, "refusals write nothing");

  // Position 1: the newcomer wins over everything; the rest shift down.
  const top = await ops.addSource({ kind: "files", name: "top", path: path.join(dir, "new"), position: 1 });
  assert.equal(top.level, 4);
  assert.deepEqual(top.order, [{ name: "top", level: 4 }, { name: "personal", level: 3 }, { name: "team", level: 2 }, { name: "company", level: 1 }]);
  assert.deepEqual(levelsOf(manifestPath), { top: 4, personal: 3, team: 2, company: 1 });

  // Position N+1 (5 of 4 existing): the bottom.
  const bottom = await ops.addSource({ kind: "files", name: "bottom", path: path.join(dir, "new"), position: 5 });
  assert.equal(bottom.level, 1);
  assert.deepEqual(levelsOf(manifestPath), { top: 5, personal: 4, team: 3, company: 2, bottom: 1 });

  // A position past the end clamps to the bottom rather than failing.
  const clamped = await ops.addSource({ kind: "files", name: "clamped", path: path.join(dir, "new"), position: "99" });
  assert.equal(clamped.level, 1);
  assert.deepEqual(levelsOf(manifestPath), { top: 6, personal: 5, team: 4, company: 3, bottom: 2, clamped: 1 });

  // In the middle, by CASCADE order (level), not by array order.
  const middle = await ops.addSource({ kind: "files", name: "middle", path: path.join(dir, "new"), position: 3 });
  assert.equal(middle.level, 5);
  assert.deepEqual(levelsOf(manifestPath), { top: 7, personal: 6, middle: 5, team: 4, company: 3, bottom: 2, clamped: 1 });
});

test("addSource with position onto a tied cascade breaks the tie by name and keeps a Pack assignment in step", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "zeta", 2),
    folderLayer(dir, "alpha", 2),
    { name: "pack-demo", level: 0, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" },
  ], {
    v2: true,
    packs: { demo: {
      installedVersions: [{ version: "1.0.0", checksum: "sha256:test" }],
      assignments: [{ profile: "default", layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
    } },
  });
  fs.mkdirSync(path.join(dir, "new"));
  const ops = createSourceOperations({ manifestPath });
  const added = await ops.addSource({ kind: "files", name: "mid", path: path.join(dir, "new"), position: 2 });
  // Cascade order was alpha(2), zeta(2) [tie → name], pack-demo(0); insert at 2.
  assert.deepEqual(added.order, [{ name: "alpha", level: 4 }, { name: "mid", level: 3 }, { name: "zeta", level: 2 }, { name: "pack-demo", level: 1 }]);
  const manifest = readContextManifest(manifestPath, { allowMissing: false });
  assert.equal(manifest.packs.demo.assignments[0].level, 1);
});

// ---- patchSource: level ------------------------------------------------------

test("patchSource refuses null / non-numeric / fractional levels with LEVEL_INVALID and leaves the layer alone", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [folderLayer(dir, "a", 2), folderLayer(dir, "b", 1)]);
  const ops = createSourceOperations({ manifestPath });
  for (const level of [null, "abc", 1.5, "1.5", "", true, [2]]) {
    await rejects(() => ops.patchSource({ name: "a", level }), "LEVEL_INVALID", 400);
  }
  assert.deepEqual(levelsOf(manifestPath), { a: 2, b: 1 });

  // Numbers and numeric strings land; a duplicate level stays legal on PATCH.
  await ops.patchSource({ name: "a", level: "7" });
  assert.equal(levelsOf(manifestPath).a, 7);
  await ops.patchSource({ name: "a", level: 1 });
  assert.deepEqual(levelsOf(manifestPath), { a: 1, b: 1 });
  await ops.patchSource({ name: "a", level: -3 });
  assert.equal(levelsOf(manifestPath).a, -3);
  // Level is validated before an unknown name is looked up (cheap check first),
  // but an unknown name with a valid level is still the 404 it always was.
  await rejects(() => ops.patchSource({ name: "ghost", level: 2 }), "SOURCE_NOT_FOUND", 404);
});

test("patchSource on a Pack layer moves the assignment instead of dying on pack-layer-drift", async (t) => {
  const dir = tempDir(t);
  const manifestPath = writeManifest(dir, [
    folderLayer(dir, "personal", 3),
    { name: "pack-demo", level: 0, path: "packs/demo/1.0.0", origin: "pack:demo@1.0.0" },
  ], {
    packs: { demo: {
      installedVersions: [{ version: "1.0.0", checksum: "sha256:test" }],
      assignments: [{ profile: null, layerName: "pack-demo", activeVersion: "1.0.0", level: 0 }],
    } },
  });
  const ops = createSourceOperations({ manifestPath });
  await ops.patchSource({ name: "pack-demo", level: 5 });
  const manifest = readContextManifest(manifestPath, { allowMissing: false });
  assert.equal(manifest.layers.find((layer) => layer.name === "pack-demo").level, 5);
  assert.equal(manifest.packs.demo.assignments[0].level, 5);
});
