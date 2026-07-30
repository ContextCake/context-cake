// Unit tests for the retrieval module. The eval in packages/core/eval/ measures
// whether ranking is *good*; these pin the properties it must never lose, so a
// regression names itself instead of showing up as a metric that slipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stem } from "../src/stem.mjs";
import { analyze, searchConcepts, searchCaptures } from "../src/search.mjs";

// A slice of Porter's own published vocabulary. If these drift, the stemmer has
// stopped being Porter and the eval numbers are measuring something else.
const PORTER_REFERENCE = [
  ["caresses", "caress"], ["ponies", "poni"], ["ties", "ti"], ["cats", "cat"],
  ["feed", "fe"], ["agreed", "agre"], ["plastered", "plaster"], ["motoring", "motor"],
  ["sing", "sing"], ["conflated", "conflat"], ["troubled", "troubl"], ["sized", "size"],
  ["hopping", "hop"], ["tanned", "tan"], ["falling", "fall"], ["hissing", "hiss"],
  ["fizzed", "fizz"], ["failing", "fail"], ["filing", "file"], ["happy", "happi"],
  ["sky", "sky"], ["relational", "relat"], ["conditional", "condit"], ["rational", "ration"],
  ["digitizer", "digit"], ["vietnamization", "vietnam"], ["predication", "predic"],
  ["operator", "oper"], ["feudalism", "feudal"], ["decisiveness", "decis"],
  ["hopefulness", "hope"], ["callousness", "callous"], ["formaliti", "formal"],
  ["sensitiviti", "sensit"], ["sensibiliti", "sensibl"], ["triplicate", "triplic"],
  ["formative", "form"], ["formalize", "formal"], ["electriciti", "electr"],
  ["electrical", "electr"], ["hopeful", "hope"], ["goodness", "good"],
  ["revival", "reviv"], ["allowance", "allow"], ["inference", "infer"],
  ["airliner", "airlin"], ["gyroscopic", "gyroscop"], ["adjustable", "adjust"],
  ["defensible", "defens"], ["irritant", "irrit"], ["replacement", "replac"],
  ["dependent", "depend"], ["adoption", "adopt"], ["communism", "commun"],
  ["activate", "activ"], ["homologous", "homolog"], ["effective", "effect"],
  ["bowdlerize", "bowdler"], ["probate", "probat"], ["rate", "rate"],
  ["cease", "ceas"], ["controll", "control"], ["roll", "roll"],
];

test("the stemmer is Porter, not an invention", () => {
  for (const [input, expected] of PORTER_REFERENCE) {
    assert.equal(stem(input), expected, `stem(${input})`);
  }
});

test("short tokens and acronyms keep their final s", () => {
  // "tls" must not become "tl": three-letter acronyms are common in this corpus
  // and stripping the s makes them collide with unrelated words.
  assert.equal(stem("tls"), "tls");
  assert.equal(stem("api"), "api");
  assert.equal(stem("aws"), "aws");
});

test("a query reaches a document written in a different inflection", () => {
  const pairs = [
    ["databases", "database"],
    ["skewed", "skew"],
    ["paginate", "pagination"],
    ["compatible", "compatibility"],
    ["timestamps", "timestamp"],
    ["reviews", "review"],
    ["deployments", "deployment"],
    ["reprocessing", "reprocess"],
  ];
  for (const [asked, written] of pairs) {
    assert.deepEqual(analyze(asked), analyze(written), `${asked} vs ${written}`);
  }
});

test("stemming is not synonymy, and the gaps are Porter's own", () => {
  // Porter strips -ing at step 1b but -ance at step 4, so these two forms of the
  // same word do not meet. Recorded rather than patched: the moment the stemmer
  // is hand-adjusted to this repo's vocabulary, the eval starts grading a
  // stemmer that was fitted to the questions it is being graded on.
  assert.notDeepEqual(analyze("rebalancing"), analyze("rebalance"));

  // And no stemmer bridges a genuine synonym. "keep" will not reach "retained";
  // closing that gap needs a different mechanism, not a bigger suffix list.
  assert.notDeepEqual(analyze("keep"), analyze("retained"));
});

test("a hyphenated compound is reachable from its parts", () => {
  const compound = analyze("exactly-once");
  for (const part of analyze("exactly once")) {
    assert.ok(compound.includes(part), `expected ${part} in ${compound.join(",")}`);
  }
});

// ---- fixtures --------------------------------------------------------------

function layer(name, level, docs) {
  return {
    name,
    level,
    async listConceptIds() {
      return Object.keys(docs);
    },
    async loadConcept(id) {
      const doc = docs[id];
      if (!doc) return null;
      return {
        frontmatter: doc.frontmatter ?? {},
        sections: [{ key: "body", heading: null, lines: (doc.body ?? "").split("\n") }],
      };
    },
    close() {},
  };
}

const padding = "The platform team reviews this document every quarter as part of the standing operational review. ";

test("a precise short document outranks a long one that mentions the term in passing", async () => {
  const layers = [
    layer("company", 0, {
      "notes/sprawl": {
        frontmatter: { title: "Operational miscellany" },
        // Says "checkpoint" more times than the precise doc, but says everything
        // else too. Occurrence counting ranked this first; length normalization
        // is what stops it.
        body: `${padding.repeat(12)} checkpoint. ${padding.repeat(12)} checkpoint. ${padding.repeat(12)} checkpoint.`,
      },
      "runbooks/checkpoint": {
        frontmatter: { title: "Checkpoint recovery" },
        body: "Restore the job from its last checkpoint before investigating.",
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "checkpoint", limit: 5 });
  assert.equal(hits[0].id, "runbooks/checkpoint");
});

test("a word in every document does not decide the ranking", async () => {
  const layers = [
    layer("company", 0, {
      "a/one": { frontmatter: { title: "One" }, body: `service service service ${padding}` },
      "a/two": { frontmatter: { title: "Two" }, body: `service service ${padding}` },
      "a/three": { frontmatter: { title: "Three" }, body: `service kafka ${padding}` },
    }),
  ];

  // "service" is in all three, so it carries almost no information; "kafka"
  // is in one and must decide the winner.
  const hits = await searchConcepts(layers, { query: "service kafka", limit: 5 });
  assert.equal(hits[0].id, "a/three");
});

test("a concept several layers speak to is returned once, highest layer first", async () => {
  const docs = { "decisions/stack": { frontmatter: { title: "Stack" }, body: "kafka streaming platform" } };
  const layers = [
    layer("company", 0, docs),
    layer("personal", 3, docs),
    layer("team", 2, docs),
  ];

  const hits = await searchConcepts(layers, { query: "kafka", limit: 5 });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].layers, ["personal", "team", "company"]);
});

test("an empty or unsearchable query is refused rather than matching everything", async () => {
  const layers = [layer("company", 0, { "a/one": { body: "anything" } })];
  await assert.rejects(() => searchConcepts(layers, { query: "" }), /non-empty query/);
  await assert.rejects(() => searchConcepts(layers, { query: "   " }), /at least one searchable token/);
  await assert.rejects(() => searchCaptures(layers, { query: "!!!" }), /at least one searchable token/);
});

test("captures decay: same relevance, the fresher one wins", async () => {
  const now = Date.parse("2026-07-29T00:00:00Z");
  const layers = [
    layer("live", 1, {
      "captures/old": {
        frontmatter: { title: "Rebalance storm", kind: "gotcha", captured: "2026-06-01T00:00:00Z" },
        body: "consumer group rebalance storm after deploy",
      },
      "captures/new": {
        frontmatter: { title: "Rebalance storm", kind: "gotcha", captured: "2026-07-28T00:00:00Z" },
        body: "consumer group rebalance storm after deploy",
      },
    }),
  ];

  const hits = await searchCaptures(layers, { query: "rebalance storm", limit: 5, now });
  assert.equal(hits[0].id, "captures/new");
  assert.ok(hits[0].score > hits[1].score * 2, "a two-month-old capture should be well below a one-day-old one");
});

test("captures with an unparseable date still surface instead of poisoning the sort", async () => {
  const now = Date.parse("2026-07-29T00:00:00Z");
  const layers = [
    layer("live", 1, {
      "captures/broken": {
        frontmatter: { title: "Rebalance", kind: "gotcha", captured: "not a date" },
        body: "consumer group rebalance storm",
      },
    }),
  ];

  const hits = await searchCaptures(layers, { query: "rebalance", limit: 5, now });
  assert.equal(hits.length, 1);
  assert.ok(Number.isFinite(hits[0].score));
});

test("the kinds filter excludes other capture kinds", async () => {
  const layers = [
    layer("live", 1, {
      "captures/a": { frontmatter: { title: "A", kind: "gotcha", captured: "2026-07-01T00:00:00Z" }, body: "kafka lag" },
      "captures/b": { frontmatter: { title: "B", kind: "decision", captured: "2026-07-01T00:00:00Z" }, body: "kafka lag" },
    }),
  ];

  const hits = await searchCaptures(layers, { query: "kafka lag", kinds: ["decision"], limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.id), ["captures/b"]);
});

test("only captures/ documents reach find_captures", async () => {
  const layers = [
    layer("live", 1, {
      "captures/a": { frontmatter: { title: "A", kind: "gotcha", captured: "2026-07-01T00:00:00Z" }, body: "kafka lag" },
      "decisions/streaming": { frontmatter: { title: "Streaming" }, body: "kafka lag" },
    }),
  ];

  const hits = await searchCaptures(layers, { query: "kafka lag", limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.id), ["captures/a"]);
});
