// The incremental index's one hard promise: BIT-IDENTICAL answers to
// searchConcepts over the same snapshots — same hits, same order, and scores
// equal under Object.is, not toFixed. The differential runs a seeded random
// mutation sequence (edits, adds, removals, layer add/drop) and compares
// after every step, so drift in the delta bookkeeping (documentFrequency,
// field totals, enumeration order) cannot hide behind a lucky corpus.
import test from "node:test";
import assert from "node:assert/strict";
import { searchConcepts } from "../src/search.mjs";
import { createSearchIndex } from "../src/search-index.mjs";

// Deterministic PRNG — the point of the differential is reproducibility.
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

const QUERIES = [
  "postgres", "deploy rollout", "exactly once", "auth token cache",
  "marker-3", "vault ranking snapshot", "nonexistent-term", "runbook",
];

test("incremental index answers Object.is-equal to searchConcepts across a mutation sequence", async () => {
  const rand = mulberry32(0xcafe);
  const index = createSearchIndex();

  // Two layers with overlapping ids so the best-layer merge is exercised.
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
      const contributing = layers.map((l) => ({ name: l.name, level: l.level, gen: l.snap.gen, ids: l.snap.ids, concepts: l.snap.concepts }));
      const incremental = index.search(contributing, { query, limit: 10 });
      const reference = await searchConcepts(layers.map((l) => legacyView({ name: l.name, level: l.level, ...l.snap })), { query, limit: 10 });
      assert.equal(incremental.length, reference.length, `${label} · "${query}" · hit count`);
      for (let i = 0; i < reference.length; i += 1) {
        assert.equal(incremental[i].id, reference[i].id, `${label} · "${query}" · hit ${i} id`);
        assert.ok(Object.is(incremental[i].score, reference[i].score), `${label} · "${query}" · hit ${i} score ${incremental[i].score} vs ${reference[i].score}`);
        assert.equal(incremental[i].snippet, reference[i].snippet, `${label} · "${query}" · hit ${i} snippet`);
        assert.deepEqual(incremental[i].layers, reference[i].layers, `${label} · "${query}" · hit ${i} layers`);
        assert.equal(incremental[i].title, reference[i].title, `${label} · "${query}" · hit ${i} title`);
      }
    }
  };

  await compare("initial");

  // A carried-forward snapshot: same concept OBJECTS, new snapshot — the
  // WeakMap path. Nothing may change in the answers.
  layers = layers.map((l) => ({ ...l, snap: makeSnapshot([...l.snap.concepts]) }));
  await compare("carried");

  // 30 random mutations, comparing after each.
  for (let step = 0; step < 30; step += 1) {
    const which = rand() < 0.6 ? "personal" : "team";
    const docs = layerDocs[which];
    const roll = rand();
    if (roll < 0.45 && docs.size > 3) {
      // Edit: a NEW object for one id (what a re-read produces).
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

  // A layer leaves the manifest entirely.
  layers = layers.filter((l) => l.name !== "team");
  await compare("layer removed");

  // And a new one arrives.
  const company = new Map(Array.from({ length: 10 }, (_, i) => [`concept-${i * 3}`, makeConcept(rand, seq++)]));
  layers = [...layers, { name: "company", level: 0, snap: makeSnapshot([...company]) }];
  await compare("layer added");

  // The zero-hit query answers empty, not throws.
  const contributing = layers.map((l) => ({ name: l.name, level: l.level, gen: l.snap.gen, ids: l.snap.ids, concepts: l.snap.concepts }));
  assert.deepEqual(index.search(contributing, { query: "zzz-not-in-vocab", limit: 10 }), []);

  index.close();
});

test("eviction and rebuild land on the same answers", async () => {
  const rand = mulberry32(0xbeef);
  let seq = 100;
  const docs = new Map(Array.from({ length: 20 }, (_, i) => [`n-${i}`, makeConcept(rand, seq++)]));
  const snap = makeSnapshot([...docs]);
  const layers = [{ name: "vault", level: 3, snap }];
  const contributing = () => layers.map((l) => ({ name: l.name, level: l.level, gen: l.snap.gen, ids: l.snap.ids, concepts: l.snap.concepts }));

  const index = createSearchIndex({ idleEvictMs: 10 });
  const before = index.search(contributing(), { query: "postgres deploy", limit: 10 });
  await new Promise((resolve) => setTimeout(resolve, 40)); // let the eviction land
  const after = index.search(contributing(), { query: "postgres deploy", limit: 10 });
  assert.deepEqual(after, before);
  index.close();
});

test('source and effective type filters select before top-k without changing global scores or index state', async t => {
  const index = createSearchIndex();
  t.after(() => index.close());
  const doc = (title, type, text = 'build and test', extra = {}) => ({ frontmatter: { title, ...(type ? { type } : {}), ...extra }, sections: [{ key: 'body', text }] });
  const personal = Array.from({ length: 25 }, (_, i) => [`top-${i}`, doc('Build and test', 'note')]);
  const team = [
    ['buried', doc('Long guide', 'spec', `build and test ${'other '.repeat(100)}`)],
    ['shared', doc('No matching words', 'spec', 'unrelated')],
    ['inherited', doc('Guide', 'spec')],
    ['overridden', doc('Guide', 'spec')],
    ['dated', doc('Guide', 'spec', 'build', { updated: '2026-09-02' })],
  ];
  personal.push(['shared', doc('Build and test', 'decision')], ['inherited', doc('Guide')],
    ['overridden', doc('Guide', null, 'build', { override: 'full' })],
    ['dated', doc('Guide', 'note', 'build', { updated: '2026-09-01' })]);
  const views = [
    { name: 'personal', level: 3, ...makeSnapshot(personal) },
    { name: 'specs', level: 3, ...makeSnapshot(team) },
  ];
  const query = 'build and test';
  const all = index.search(views, { query, limit: 100 });
  assert.ok(all.findIndex(hit => hit.id === 'buried') >= 20, 'fixture must reproduce the global top-20 false negative');
  const sourceIds = new Set(team.map(([id]) => id));
  const selected = index.search(views, { query, limit: 20, source: 'specs' });
  assert.deepEqual(selected, all.filter(hit => sourceIds.has(hit.id)).slice(0, 20));
  assert.deepEqual(selected.find(hit => hit.id === 'shared').layers, ['personal'], 'membership includes a source whose own contribution has no query match');
  const types = new Map([['buried', 'spec'], ['shared', 'decision'], ['inherited', 'spec'], ['overridden', 'concept'], ['dated', 'spec']]);
  for (const type of ['spec', 'decision', 'concept', 'note', 'unknown']) {
    assert.deepEqual(index.search(views, { query, limit: 20, type }), all.filter(hit => (types.get(hit.id) ?? 'note') === type).slice(0, 20));
    assert.deepEqual(index.search(views, { query, limit: 20, type, source: 'specs' }), all.filter(hit => sourceIds.has(hit.id) && types.get(hit.id) === type).slice(0, 20));
  }
  assert.deepEqual(index.search(views, { query, source: 'missing' }), []);
  assert.deepEqual(index.search(views, { query, limit: 100 }), all, 'filter changes must leave the full index warm and unchanged');
  views[1] = { name: 'specs', level: 3, ...makeSnapshot(team.filter(([id]) => id !== 'buried')) };
  assert.equal(index.search(views, { query, source: 'specs' }).some(hit => hit.id === 'buried'), false, 'source membership follows incremental removals');
});
