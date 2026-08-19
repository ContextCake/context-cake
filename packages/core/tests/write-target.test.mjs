// write.mjs default-target selection: the batch writer lands captured signals
// in the highest eligible layer BELOW the top of the cascade — where "top" is
// whatever the profile's highest level is, measured over every layer before
// the eligibility filter. It used to be the literal 3, which was only ever the
// documented default and made a hand-authored 5/4 manifest write into 5 and a
// 2/0 manifest (no personal layer) write into 2. Whatever it picks when
// --target-layer is omitted, it says so (stderr) — the destination changed
// with the rule for those manifests, and a silent change is the worst kind.

import assert from "node:assert/strict";
import test from "node:test";

import { selectTargetLayer, topCascadeLevel } from "../src/write.mjs";

// The shape main() hands selectTargetLayer: eligible layers only, with
// numeric levels. `all` stands in for runtime.selection.layers.
function eligible(all) {
  return all
    .filter((layer) => (layer.source ?? "okf-local") === "okf-local" && layer.live !== true)
    .map((layer) => ({ name: layer.name, level: Number(layer.level), root: `/tmp/${layer.name}` }));
}

/** The one line selectTargetLayer prints when it picked the default target itself. */
function assertNotice(warnings, name, rule = "the highest layer below the top of the cascade") {
  assert.equal(warnings.length, 1, `expected exactly one notice, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], new RegExp(`^writing to "${name}" — ${rule}; pass --target-layer to choose$`));
}

function withWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("topCascadeLevel is the highest level over every layer, ineligible ones included", () => {
  assert.equal(topCascadeLevel([{ level: 3 }, { level: 2 }, { level: 0 }]), 3);
  assert.equal(topCascadeLevel([{ level: "5" }, { level: 4 }]), 5);
  assert.equal(topCascadeLevel([{ level: 3, source: "files" }, { level: 2 }]), 3);
  assert.equal(topCascadeLevel([]), Number.NEGATIVE_INFINITY);
});

test("3/2/0 → team, and says so", () => {
  const all = [{ name: "personal", level: 3 }, { name: "team", level: 2 }, { name: "company", level: 0 }];
  const { result, warnings } = withWarnings(() => selectTargetLayer(eligible(all), undefined, topCascadeLevel(all)));
  assert.equal(result.name, "team");
  assertNotice(warnings, "team");
});

test("a Markdown-folder personal layer still counts as the top: files-3 / okf-2 / mcp-0 → team", () => {
  const all = [
    { name: "notes", level: 3, source: "files" },
    { name: "team", level: 2 },
    { name: "graph", level: 0, source: "mcp" },
  ];
  const layers = eligible(all);
  assert.deepEqual(layers.map((layer) => layer.name), ["team"], "only the okf layer is eligible");
  const { result, warnings } = withWarnings(() => selectTargetLayer(layers, undefined, topCascadeLevel(all)));
  assert.equal(result.name, "team");
  assertNotice(warnings, "team");
});

test("hand-authored 5/4 → 4 (the literal 3 used to warn and write into 5)", () => {
  const all = [{ name: "mine", level: 5 }, { name: "ours", level: 4 }];
  const { result, warnings } = withWarnings(() => selectTargetLayer(eligible(all), undefined, topCascadeLevel(all)));
  assert.equal(result.name, "ours");
  assertNotice(warnings, "ours");
});

test("2/0 with no personal layer → 0 (the literal 3 used to write into 2) — named, since the destination moved with the rule", () => {
  const all = [{ name: "team", level: 2 }, { name: "company", level: 0 }];
  const { result, warnings } = withWarnings(() => selectTargetLayer(eligible(all), undefined, topCascadeLevel(all)));
  assert.equal(result.name, "company");
  assertNotice(warnings, "company");
});

test("a single layer is the top and the only option: say so, then use it", () => {
  const all = [{ name: "only", level: 2 }];
  const { result, warnings } = withWarnings(() => selectTargetLayer(eligible(all), undefined, topCascadeLevel(all)));
  assert.equal(result.name, "only");
  assertNotice(warnings, "only", "only the top-of-cascade layer is writable");
});

test("every eligible layer tied at the top says so too; ties below the top pick the first by sort", () => {
  const tiedTop = [{ name: "a", level: 3 }, { name: "b", level: 3 }];
  const top = withWarnings(() => selectTargetLayer(eligible(tiedTop), undefined, topCascadeLevel(tiedTop)));
  assert.ok(["a", "b"].includes(top.result.name));
  assertNotice(top.warnings, top.result.name, "only the top-of-cascade layer is writable");

  const tiedBelow = [{ name: "personal", level: 3 }, { name: "x", level: 2 }, { name: "y", level: 2 }];
  const below = withWarnings(() => selectTargetLayer(eligible(tiedBelow), undefined, topCascadeLevel(tiedBelow)));
  assert.equal(below.result.level, 2);
  assertNotice(below.warnings, below.result.name);
});

test("--target-layer wins regardless of level, silently; an unknown name lists the eligible ones", () => {
  const all = [{ name: "personal", level: 3 }, { name: "team", level: 2 }];
  const explicit = withWarnings(() => selectTargetLayer(eligible(all), "personal", 3));
  assert.equal(explicit.result.name, "personal");
  assert.deepEqual(explicit.warnings, [], "an explicit target needs no notice");
  assert.throws(() => selectTargetLayer(eligible(all), "ghost", 3), /Layer not found in manifest: ghost\. Available: personal, team/);
  assert.throws(() => selectTargetLayer([], undefined, 3), /no layers/);
});

test("topLevel defaults to the eligible layers' own top when the caller passes none", () => {
  const layers = eligible([{ name: "personal", level: 3 }, { name: "team", level: 2 }]);
  const { result, warnings } = withWarnings(() => selectTargetLayer(layers));
  assert.equal(result.name, "team");
  assertNotice(warnings, "team");
});
