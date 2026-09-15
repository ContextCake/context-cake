// The SQLite-backed store's hard promise, same discipline as
// search-index.test.mjs: BIT-IDENTICAL answers to searchConcepts AND
// createSearchIndex over the same snapshots — same hits, same order, scores
// equal under Object.is. Plus durability scenarios specific to a store that
// persists across restarts: reopen-without-reanalysis, identity change,
// dropped layers, and concurrent opens on one file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchConcepts } from "../src/search.mjs";
import { createSearchIndex } from "../src/search-index.mjs";
import { createSearchStore, isSearchStoreAvailable } from "../src/search-store.mjs";

// Deterministic PRNG — reproducibility is the point of the differential.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "postgres", "database", "deploy", "rollout", "incident", "auth", "token",
  "cache", "index", "vault", "exactly-once", "retry", "budget", "runbook",
  "schema", "migration", "search", "ranking", "snapshot", "conflict",
];

function makeConcept(rand, seed) {
  const words = (count) => Array.from({ length: count }, () => VOCAB[Math.floor(rand() * VOCAB.length)]);
  return {
    frontmatter: {
      title: words(3).join(" "),
      description: rand() < 0.5 ? words(5).join(" ") : undefined,
      tags: rand() < 0.4 ? words(2).join(",") : undefined,
    },
    sections: [
      { key: "body", heading: "## Body {#body}", text: words(30 + Math.floor(rand() * 40)).join(" ") + ` marker-${seed}` },
      ...(rand() < 0.5 ? [{ key: "notes", heading: "## Notes {#notes}", text: words(15).join(" ") }] : []),
    ],
  };
}

let GEN = 0;
function makeSnapshot(conceptEntries) {
  const ids = conceptEntries.map(([id]) => id).sort();
  return { gen: ++GEN, ids, concepts: new Map(conceptEntries) };
}

/** The adapter-shaped view searchConcepts wants, over the same snapshot. */
function legacyView(layer) {
  return {
    name: layer.name,
    level: layer.level,
    async listConceptIds() { return layer.ids; },
    async loadConcept(id) { return layer.concepts.get(id) ?? null; },
  };
}

/** contributing-shaped view both createSearchIndex and createSearchStore take. */
function contributingView(layer, identity) {
  return {
    name: layer.name, level: layer.level, gen: layer.snap.gen, ids: layer.snap.ids,
    concepts: layer.snap.concepts, identity: identity ?? layer.name,
  };
}

const QUERIES = [
  "postgres", "deploy rollout", "exactly once", "auth token cache",
  "marker-3", "vault ranking snapshot", "nonexistent-term", "runbook",
];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-store-test-"));
  return { dir, file: path.join(dir, "index.sqlite") };
}

test("isSearchStoreAvailable is true on this Node", () => {
  assert.equal(isSearchStoreAvailable(), true);
});

for (const mode of ["file", "memory"]) {
  test(`store answers Object.is-equal to searchConcepts and createSearchIndex across a mutation sequence (${mode})`, async (t) => {
    const rand = mulberry32(0xcafe);
    const legacyIndex = createSearchIndex();
    let tmp = null;
    let file = ":memory:";
    if (mode === "file") {
      tmp = tempFile();
      file = tmp.file;
    }
    const store = createSearchStore({ file });
    t.after(() => {
      store.close();
      legacyIndex.close();
      if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
    });

    let seq = 0;
    const layerDocs = {
      personal: new Map(Array.from({ length: 40 }, (_, i) => [`concept-${i}`, makeConcept(rand, seq++)])),
      team: new Map(Array.from({ length: 25 }, (_, i) => [`concept-${i * 2}`, makeConcept(rand, seq++)])),
    };
    let layers = [
      { name: "personal", level: 3, snap: makeSnapshot([...layerDocs.personal]) },
      { name: "team", level: 2, snap: makeSnapshot([...layerDocs.team]) },
    ];

    const compare = async (label) => {
      for (const query of QUERIES) {
        if (query === "nonexistent-term") continue; // zero hits both ways; covered once below
        const contributing = layers.map((l) => contributingView(l));
        const legacyViews = layers.map((l) => legacyView({ name: l.name, level: l.level, ...l.snap }));
        const reference = await searchConcepts(legacyViews, { query, limit: 10 });
        for (const extra of [{}, { source: layers[0].name }, { type: "concept" }, { source: layers[0].name, type: "concept" }]) {
          const opts = { query, limit: 10, ...extra };
          const viaIndex = legacyIndex.search(contributing, opts);
          const viaStore = store.search(contributing, opts);
          assert.equal(viaStore.length, viaIndex.length, `${label} · "${query}" · ${JSON.stringify(extra)} · hit count`);
          for (let i = 0; i < viaIndex.length; i += 1) {
            assert.equal(viaStore[i].id, viaIndex[i].id, `${label} · "${query}" · ${JSON.stringify(extra)} · hit ${i} id`);
            assert.ok(Object.is(viaStore[i].score, viaIndex[i].score), `${label} · "${query}" · ${JSON.stringify(extra)} · hit ${i} score ${viaStore[i].score} vs ${viaIndex[i].score}`);
            assert.equal(viaStore[i].snippet, viaIndex[i].snippet, `${label} · "${query}" · ${JSON.stringify(extra)} · hit ${i} snippet`);
            assert.deepEqual(viaStore[i].layers, viaIndex[i].layers, `${label} · "${query}" · ${JSON.stringify(extra)} · hit ${i} layers`);
            assert.equal(viaStore[i].title, viaIndex[i].title, `${label} · "${query}" · ${JSON.stringify(extra)} · hit ${i} title`);
          }
          if (!extra.source && !extra.type) {
            assert.equal(reference.length, viaStore.length, `${label} · "${query}" · vs searchConcepts · hit count`);
            for (let i = 0; i < reference.length; i += 1) {
              assert.equal(viaStore[i].id, reference[i].id, `${label} · "${query}" · vs searchConcepts · hit ${i} id`);
              assert.ok(Object.is(viaStore[i].score, reference[i].score), `${label} · "${query}" · vs searchConcepts · hit ${i} score`);
            }
          }
        }
      }
    };

    await compare("initial");

    // A carried-forward snapshot: same concept OBJECTS, new gen.
    layers = layers.map((l) => ({ ...l, snap: makeSnapshot([...l.snap.concepts]) }));
    await compare("carried");

    for (let step = 0; step < 20; step += 1) {
      const which = rand() < 0.6 ? "personal" : "team";
      const docs = layerDocs[which];
      const roll = rand();
      if (roll < 0.45 && docs.size > 3) {
        const ids = [...docs.keys()];
        const id = ids[Math.floor(rand() * ids.length)];
        docs.set(id, makeConcept(rand, seq++));
      } else if (roll < 0.7) {
        docs.set(`concept-new-${seq}`, makeConcept(rand, seq++));
      } else if (docs.size > 3) {
        const ids = [...docs.keys()];
        docs.delete(ids[Math.floor(rand() * ids.length)]);
      }
      layers = layers.map((l) => (l.name === which ? { ...l, snap: makeSnapshot([...docs]) } : l));
      await compare(`step ${step}`);
    }

    layers = layers.filter((l) => l.name !== "team");
    await compare("layer removed");

    const company = new Map(Array.from({ length: 10 }, (_, i) => [`concept-${i * 3}`, makeConcept(rand, seq++)]));
    layers = [...layers, { name: "company", level: 0, snap: makeSnapshot([...company]) }];
    await compare("layer added");

    const contributing = layers.map((l) => contributingView(l));
    assert.deepEqual(store.search(contributing, { query: "zzz-not-in-vocab", limit: 10 }), []);
  });
}

test("restart equivalence: reopening on the same file re-analyzes nothing unless content changed", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x1234);
  let seq = 0;
  const docs = new Map(Array.from({ length: 15 }, (_, i) => [`d-${i}`, makeConcept(rand, seq++)]));
  const meta = new Map([...docs.keys()].map((id, i) => [id, { rel: `${id}.md`, ext: ".md", size: 100 + i, mtimeMs: 1000 + i, authoredDate: "2026-01-01" }]));
  const snap = makeSnapshot([...docs]);
  const view = { name: "vault", level: 3, gen: snap.gen, ids: snap.ids, concepts: snap.concepts, identity: "vault-identity", fileMeta: meta };

  const store1 = createSearchStore({ file });
  const hits1 = store1.search([view], { query: "postgres deploy", limit: 10 });
  assert.equal(store1.inspect().analyzed, 15);
  store1.close();

  // Fresh store, same file, fresh gen numbers (a new process would mint new
  // gens) and the same fingerprints (identical fileMeta) -> zero re-analysis.
  const store2 = createSearchStore({ file });
  const snap2 = makeSnapshot([...docs]); // new gen
  const view2 = { name: "vault", level: 3, gen: snap2.gen, ids: snap2.ids, concepts: snap2.concepts, identity: "vault-identity", fileMeta: meta };
  const hits2 = store2.search([view2], { query: "postgres deploy", limit: 10 });
  assert.equal(store2.inspect().analyzed, 0, "reopen with identical fingerprints must not re-analyze");
  assert.deepEqual(hits2, hits1);

  // Change one file's fingerprint -> exactly one re-analysis.
  const changedId = [...docs.keys()][0];
  const meta3 = new Map(meta);
  meta3.set(changedId, { ...meta.get(changedId), mtimeMs: meta.get(changedId).mtimeMs + 1 });
  const snap3 = makeSnapshot([...docs]);
  const view3 = { name: "vault", level: 3, gen: snap3.gen, ids: snap3.ids, concepts: snap3.concepts, identity: "vault-identity", fileMeta: meta3 };
  store2.search([view3], { query: "postgres deploy", limit: 10 });
  assert.equal(store2.inspect().analyzed, 1, "only the one fingerprint-changed doc re-analyzes");
  store2.close();

  // Without fileMeta at all (remote-style, a fresh layer never seen with
  // fileMeta before): identical content hashes to the same fingerprint on
  // reopen -> zero re-analysis; one changed body -> one re-analysis.
  const { dir: dir2, file: file2 } = tempFile();
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const storeR1 = createSearchStore({ file: file2 });
  const snapR1 = makeSnapshot([...docs]);
  const viewR1 = { name: "remote", level: 3, gen: snapR1.gen, ids: snapR1.ids, concepts: snapR1.concepts, identity: "remote-identity" };
  storeR1.search([viewR1], { query: "postgres deploy", limit: 10 });
  storeR1.close();

  const storeR2 = createSearchStore({ file: file2 });
  const snapR2 = makeSnapshot([...docs]);
  const viewR2 = { name: "remote", level: 3, gen: snapR2.gen, ids: snapR2.ids, concepts: snapR2.concepts, identity: "remote-identity" };
  storeR2.search([viewR2], { query: "postgres deploy", limit: 10 });
  assert.equal(storeR2.inspect().analyzed, 0, "content-hash fingerprint must match across reopen with no fileMeta");

  const anId = [...docs.keys()][1];
  const changedDocs = new Map(docs);
  changedDocs.set(anId, makeConcept(rand, 9999));
  const snapR3 = makeSnapshot([...changedDocs]);
  const viewR3 = { name: "remote", level: 3, gen: snapR3.gen, ids: snapR3.ids, concepts: snapR3.concepts, identity: "remote-identity" };
  storeR2.search([viewR3], { query: "postgres deploy", limit: 10 });
  assert.equal(storeR2.inspect().analyzed, 1, "one changed body re-analyzes exactly one document");
  storeR2.close();
});

test("identity change re-analyzes everything; a dropped layer disappears", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x5678);
  let seq = 0;
  const docs = new Map(Array.from({ length: 10 }, (_, i) => [`x-${i}`, makeConcept(rand, seq++)]));
  const meta = new Map([...docs.keys()].map((id, i) => [id, { rel: `${id}.md`, ext: ".md", size: 100 + i, mtimeMs: 1000 + i }]));

  const store = createSearchStore({ file });
  t.after(() => store.close());

  const snap1 = makeSnapshot([...docs]);
  const view1 = { name: "vault", level: 3, gen: snap1.gen, ids: snap1.ids, concepts: snap1.concepts, identity: "identity-a", fileMeta: meta };
  store.search([view1], { query: "postgres", limit: 10 });
  const analyzedFirst = store.inspect().analyzed;
  assert.ok(analyzedFirst > 0);

  // Same rel/size/mtime (fileMeta unchanged), but a repointed folder ->
  // different identity must invalidate every document.
  const snap2 = makeSnapshot([...docs]);
  const view2 = { name: "vault", level: 3, gen: snap2.gen, ids: snap2.ids, concepts: snap2.concepts, identity: "identity-b", fileMeta: meta };
  store.search([view2], { query: "postgres", limit: 10 });
  assert.equal(store.inspect().analyzed, analyzedFirst + docs.size, "identity change must re-analyze every document");
  assert.equal(store.inspect().documents, docs.size);

  // Layer dropped entirely from contributing.
  const before = store.search([view2], { query: "postgres", limit: 10 });
  assert.ok(before.length > 0);
  const empty = store.search([], { query: "postgres", limit: 10 });
  assert.deepEqual(empty, []);
  assert.equal(store.inspect().documents, 0, "a dropped layer's documents disappear from the store");
});

test("search() reads `body` only for surviving hits, never the whole corpus", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x2222);
  let seq = 0;
  const docs = new Map(Array.from({ length: 200 }, (_, i) => [`b-${i}`, makeConcept(rand, seq++)]));
  const snap = makeSnapshot([...docs]);
  const view = { name: "vault", level: 3, gen: snap.gen, ids: snap.ids, concepts: snap.concepts, identity: "vault" };

  const store = createSearchStore({ file });
  t.after(() => store.close());

  const hits = store.search([view], { query: "postgres deploy", limit: 5 });
  assert.ok(hits.length > 0 && hits.length <= 5);
  assert.equal(store.inspect().bodyReads, hits.length, "body is fetched exactly once per returned hit, not per corpus document");

  const before = store.inspect().bodyReads;
  store.search([view], { query: "nonexistent-term-xyz", limit: 5 });
  assert.equal(store.inspect().bodyReads, before, "zero hits means zero body reads");
});

test("pending() names only fingerprint-mismatched ids, with no concepts required", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x3333);
  let seq = 0;
  const docs = new Map(Array.from({ length: 10 }, (_, i) => [`p-${i}`, makeConcept(rand, seq++)]));
  const meta = new Map([...docs.keys()].map((id, i) => [id, { rel: `${id}.md`, ext: ".md", size: 100 + i, mtimeMs: 1000 + i, authoredDate: "2026-01-01" }]));
  const ids = [...docs.keys()];

  const store = createSearchStore({ file });
  t.after(() => store.close());

  // Never-seen layer: every id is pending.
  const pendingView = { name: "vault", identity: "vault-id", ids, fileMeta: meta };
  assert.deepEqual(new Set(store.pending(pendingView)), new Set(ids), "unseen layer: all ids pending");

  // Sync it with full concepts (a normal search call), then re-check with a
  // view that carries fileMeta but NO concepts at all.
  const snap = makeSnapshot([...docs]);
  const fullView = {
    name: "vault", level: 3, gen: snap.gen, ids: snap.ids, concepts: snap.concepts, identity: "vault-id", fileMeta: meta,
  };
  store.search([fullView], { query: "postgres", limit: 10 });

  const noConceptView = { name: "vault", identity: "vault-id", ids, fileMeta: meta };
  assert.deepEqual(store.pending(noConceptView), [], "unchanged fingerprints: nothing pending, no concepts needed");

  // Mutate one file's fingerprint only.
  const changedId = ids[0];
  const meta2 = new Map(meta);
  meta2.set(changedId, { ...meta.get(changedId), mtimeMs: meta.get(changedId).mtimeMs + 1 });
  const changedView = { name: "vault", identity: "vault-id", ids, fileMeta: meta2 };
  assert.deepEqual(store.pending(changedView), [changedId], "only the fingerprint-changed id is pending");

  // A new id (never stored) is pending.
  const newId = "p-new";
  const meta3 = new Map(meta);
  meta3.set(newId, { rel: `${newId}.md`, ext: ".md", size: 1, mtimeMs: 1, authoredDate: null });
  const withNewView = { name: "vault", identity: "vault-id", ids: [...ids, newId], fileMeta: meta3 };
  assert.deepEqual(store.pending(withNewView), [newId]);

  // Identity change: everything pending, even with identical fileMeta.
  const reidentifiedView = { name: "vault", identity: "vault-id-2", ids, fileMeta: meta };
  assert.deepEqual(new Set(store.pending(reidentifiedView)), new Set(ids), "identity change: all ids pending");

  // No fileMeta at all: everything pending (can't prove anything unchanged
  // without reading it).
  const noMetaView = { name: "vault", identity: "vault-id", ids };
  assert.deepEqual(new Set(store.pending(noMetaView)), new Set(ids), "no fileMeta: all ids pending");
});

test("sync() keeps a fingerprint-matched doc even when its view omits the concept", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x4444);
  let seq = 0;
  const docs = new Map(Array.from({ length: 8 }, (_, i) => [`m-${i}`, makeConcept(rand, seq++)]));
  const meta = new Map([...docs.keys()].map((id, i) => [id, { rel: `${id}.md`, ext: ".md", size: 100 + i, mtimeMs: 1000 + i }]));
  const ids = [...docs.keys()];

  const store = createSearchStore({ file });
  t.after(() => store.close());

  const snap1 = makeSnapshot([...docs]);
  const view1 = { name: "vault", level: 3, gen: snap1.gen, ids: snap1.ids, concepts: snap1.concepts, identity: "v", fileMeta: meta };
  const hits1 = store.search([view1], { query: "postgres deploy", limit: 10 });
  const analyzedAfterFirst = store.inspect().analyzed;
  assert.ok(analyzedAfterFirst > 0);

  // Second sync: partial view — only ONE id's concept present (as if a
  // caller loaded just the pending() id), the rest omitted. All other docs
  // must survive unchanged and contribute to the same search results, and
  // NOTHING is re-analyzed since every fingerprint still matches.
  const changedId = ids[1];
  const newConcept = makeConcept(rand, 8888);
  const partialConcepts = new Map([[changedId, newConcept]]);
  const meta2 = new Map(meta);
  meta2.set(changedId, { ...meta.get(changedId), mtimeMs: meta.get(changedId).mtimeMs + 1 });
  const view2 = {
    name: "vault", level: 3, gen: snap1.gen + 1, ids, concepts: partialConcepts, identity: "v", fileMeta: meta2,
  };
  store.search([view2], { query: "postgres deploy", limit: 10 });
  assert.equal(store.inspect().analyzed, analyzedAfterFirst + 1, "only the one changed-fingerprint id (which HAD a concept) is re-analyzed");
  assert.equal(store.inspect().documents, docs.size, "every other document is retained, not dropped");
});

test("concurrent opens on the same file answer identically", async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rand = mulberry32(0x9999);
  let seq = 0;
  const docs = new Map(Array.from({ length: 12 }, (_, i) => [`c-${i}`, makeConcept(rand, seq++)]));
  const snap = makeSnapshot([...docs]);
  const view = { name: "vault", level: 3, gen: snap.gen, ids: snap.ids, concepts: snap.concepts, identity: "vault" };

  const storeA = createSearchStore({ file });
  const storeB = createSearchStore({ file });
  t.after(() => { storeA.close(); storeB.close(); });

  const hitsA = storeA.search([view], { query: "postgres deploy", limit: 10 });
  const hitsB = storeB.search([view], { query: "postgres deploy", limit: 10 });
  assert.deepEqual(hitsA, hitsB);
});
