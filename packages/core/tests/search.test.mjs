// Unit tests for the retrieval module. The eval in packages/core/eval/ measures
// whether ranking is *good*; these pin the properties it must never lose, so a
// regression names itself instead of showing up as a metric that slipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stem } from "../src/stem.mjs";
import { analyze, searchConcepts, searchCaptures, linkPriorMultiplier, LINK_PRIOR_WEIGHT } from "../src/search.mjs";

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
      // Most fixtures pass a single `body` string, which becomes one "body"
      // section. A fixture that wants multiple sections passes `sections`
      // directly instead: [{ key, heading, body }].
      const sections = doc.sections
        ? doc.sections.map((section) => ({ key: section.key, heading: section.heading ?? null, lines: (section.body ?? "").split("\n") }))
        : [{ key: "body", heading: null, lines: (doc.body ?? "").split("\n") }];
      return { frontmatter: doc.frontmatter ?? {}, sections };
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

// ---- inbound-link prior -----------------------------------------------------

test("inbound counts distinct concepts, not distinct layers or contributions", async () => {
  // Two layers both link runbooks/a -> standards/hub: one distinct source.
  const hubDoc = { frontmatter: { title: "Hub" }, body: "hub content about launches" };
  const layers = [
    layer("company", 0, {
      "standards/hub": hubDoc,
      "runbooks/a": { frontmatter: { title: "A" }, body: "see the [hub](../standards/hub.md) for launches" },
    }),
    layer("team", 2, {
      "standards/hub": hubDoc,
      "runbooks/a": { frontmatter: { title: "A" }, body: "see the [hub](../standards/hub.md) for launches" },
      "runbooks/b": { frontmatter: { title: "B" }, body: "also see the [hub](../standards/hub.md) for launches" },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "hub launches", limit: 5 });
  const hub = hits.find((hit) => hit.id === "standards/hub");
  // runbooks/a (two layers, one concept) and runbooks/b: two distinct sources.
  assert.equal(hub.inbound, 2);
});

test("a layer-prefixed [[layerName:path]] cross-layer link counts as inbound, not external", async () => {
  // Regression: extractLinks used to classify layer:path as an unknown URI
  // scheme (external) because it never received the corpus's layer names,
  // even though resolveLinkTarget was passed them correctly — the link was
  // filtered out one step before resolution ever ran.
  const layers = [
    layer("personal", 3, {
      "scratch/notes": {
        frontmatter: { title: "Notes" },
        body: "see [[shared:systems/hub]] for launch details",
      },
    }),
    layer("shared", 0, {
      "systems/hub": { frontmatter: { title: "Hub" }, body: "launch hub content" },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "hub launch", limit: 5 });
  const hub = hits.find((hit) => hit.id === "systems/hub");
  assert.equal(hub.inbound, 1, "the [[shared:path]] link must count toward inbound");
});

test("a self-link does not inflate a concept's own inbound count", async () => {
  const layers = [
    layer("company", 0, {
      "standards/hub": {
        frontmatter: { title: "Hub" },
        body: "this hub links to [itself](hub.md) and to nothing else about launches",
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "hub launches", limit: 5 });
  assert.equal(hits.find((hit) => hit.id === "standards/hub").inbound, 0);
});

test("a link to an id outside the corpus counts for nothing", async () => {
  const layers = [
    layer("company", 0, {
      "runbooks/a": {
        frontmatter: { title: "A" },
        body: "launches: see the [missing doc](../standards/does-not-exist.md)",
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "launches", limit: 5 });
  assert.equal(hits.find((hit) => hit.id === "runbooks/a").inbound, 0);
});

test("the link-prior multiplier is monotone increasing in inbound count and never shrinks a score", () => {
  assert.equal(linkPriorMultiplier(0), 1, "zero inbound links leaves the score unchanged");
  const values = [0, 1, 2, 6, 20, 100].map(linkPriorMultiplier);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `multiplier(${i}) should exceed multiplier(${i - 1})`);
  }
  // Log-damped: going from 6 to 100 inbound links must not multiply the boost
  // by anywhere near as much as the raw count ratio (100/6 ≈ 16.7×).
  const ratio = (linkPriorMultiplier(100) - 1) / (linkPriorMultiplier(6) - 1);
  assert.ok(ratio < 3, `log damping should keep the 6→100 boost ratio small, got ${ratio}`);
  assert.ok(LINK_PRIOR_WEIGHT >= 0.05 && LINK_PRIOR_WEIGHT <= 0.3, "weight must stay in the agreed range");
});

test("linksTo appears only on the top 3 hits and is capped at 5 targets, in document order", async () => {
  const targets = ["a", "b", "c", "d", "e", "f", "g"];
  const docs = {};
  for (const t of targets) docs[`runbooks/${t}`] = { frontmatter: { title: t }, body: `unrelated ${t}` };
  docs["runbooks/hub"] = {
    // Title match (boost 5) guarantees rank 1 regardless of how much the
    // outgoing link text lengthens the body field.
    frontmatter: { title: "launch checklist" },
    body: `launch launch launch ${targets.map((t) => `[${t}](${t}.md)`).join(" ")}`,
  };
  docs["runbooks/second"] = { frontmatter: { title: "Second" }, body: "launch launch launch launch" };
  docs["runbooks/third"] = { frontmatter: { title: "Third" }, body: "launch launch launch" };
  docs["runbooks/fourth"] = { frontmatter: { title: "Fourth" }, body: "launch" };

  const layers = [layer("company", 0, docs)];
  const hits = await searchConcepts(layers, { query: "launch", limit: 10 });
  assert.equal(hits[0].id, "runbooks/hub");
  assert.deepEqual(hits[0].linksTo, targets.slice(0, 5).map((t) => `runbooks/${t}`), "capped at 5, in document order");
  assert.ok("linksTo" in hits[1], "rank 2 carries linksTo");
  assert.ok("linksTo" in hits[2], "rank 3 carries linksTo");
  for (let i = 3; i < hits.length; i += 1) {
    assert.ok(!("linksTo" in hits[i]), `rank ${i + 1} must not carry linksTo`);
  }
});

// ---- section-level body scoring ---------------------------------------------

test("a long concept's late section outranks a short concept that dilutes the term with noise in its own section", async () => {
  const filler = "quarterly review committee reads this operational documentation during the standing cycle. ";
  const layers = [
    layer("company", 0, {
      "runbooks/procedure": {
        frontmatter: { title: "Standard operating procedure" },
        sections: [
          { key: "s1", heading: "## One", body: filler.repeat(3) },
          { key: "s2", heading: "## Two", body: filler.repeat(3) },
          { key: "s3", heading: "## Three", body: filler.repeat(3) },
          // The distinctive term lives alone in a short, LATE section — the
          // case whole-document BM25 dilutes (a 9-section runbook's real
          // answer buried in section 7 is the eval's q43-q46).
          { key: "aftercare", heading: "## Aftercare", body: "Watch for zephyr drift after the change lands." },
        ],
      },
      "notes/scratch": {
        frontmatter: { title: "Scratch notes" },
        // Same term, mentioned once, but diluted by noise INSIDE its own
        // single section — length normalization now applies to that one
        // section directly instead of to a whole multi-section document.
        sections: [{ key: "body", body: `${filler.repeat(6)} zephyr ${filler.repeat(6)}` }],
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "zephyr", limit: 5 });
  assert.equal(hits[0].id, "runbooks/procedure");
  assert.equal(hits[0].section.key, "aftercare");
});

test("the winning section's key and heading are reported, and the snippet is built from that section", async () => {
  const layers = [
    layer("company", 0, {
      "runbooks/rollout": {
        frontmatter: { title: "Rollout runbook" },
        sections: [
          { key: "prep", heading: "## Preparation {#prep}", body: "confirm the deploy window is open" },
          { key: "rollback", heading: "## Rollback {#rollback}", body: "trigger a rollback if the error budget burns too fast" },
        ],
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "rollback error budget", limit: 5 });
  assert.equal(hits[0].section.key, "rollback");
  assert.equal(hits[0].section.heading, "## Rollback {#rollback}");
  assert.ok(hits[0].snippet.includes("rollback"), `snippet should come from the winning section, got: ${hits[0].snippet}`);
});

test("a concept with no sections still scores on title, reporting section: null", async () => {
  const layers = [
    layer("company", 0, {
      "decisions/stub": { frontmatter: { title: "Zephyr initiative" }, sections: [] },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "zephyr", limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "decisions/stub");
  assert.equal(hits[0].section, null);
});

test("a title-only match (no section contains the query term) reports section: null", async () => {
  const layers = [
    layer("company", 0, {
      "decisions/zephyr-init": {
        frontmatter: { title: "Zephyr initiative" },
        sections: [
          { key: "overview", heading: "## Overview {#overview}", body: "unrelated overview text about something else" },
          { key: "details", heading: "## Details {#details}", body: "more unrelated detail text with no relation" },
        ],
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "zephyr", limit: 5 });
  assert.equal(hits[0].id, "decisions/zephyr-init");
  assert.equal(hits[0].section, null);
});

test("a tie between two equally-strong sections keeps the first one in document order", async () => {
  const layers = [
    layer("company", 0, {
      "notes/dup": {
        frontmatter: { title: "Duplicate content" },
        sections: [
          { key: "alpha", heading: "## Alpha {#alpha}", body: "kafka lag alert" },
          { key: "beta", heading: "## Beta {#beta}", body: "kafka lag alert" },
        ],
      },
    }),
  ];

  const hits = await searchConcepts(layers, { query: "kafka lag", limit: 5 });
  assert.equal(hits[0].section.key, "alpha", "equal-scoring sections keep the first one in document order");
});

test("document frequency counts a concept once even when three of its sections share a term", async () => {
  const buildLayers = (spread) =>
    layer("company", 0, {
      "notes/target": {
        frontmatter: { title: "Target" },
        sections: spread
          ? [
              { key: "a", heading: "## A", body: "wombat sighting logged" },
              { key: "b", heading: "## B", body: "wombat sighting logged" },
              { key: "c", heading: "## C", body: "wombat sighting logged" },
            ]
          : [
              // Same word count per section as the "spread" corpus above, so
              // the corpus's mean SECTION length — which both scenarios'
              // scores depend on — stays identical and only df can explain
              // a score difference.
              { key: "a", heading: "## A", body: "wombat sighting logged" },
              { key: "b", heading: "## B", body: "another filler entry" },
              { key: "c", heading: "## C", body: "extra filler notes" },
            ],
      },
      "notes/other-1": { frontmatter: { title: "Other one" }, body: "irrelevant content about kafka" },
      "notes/other-2": { frontmatter: { title: "Other two" }, body: "irrelevant content about postgres" },
    });

  const spreadHits = await searchConcepts([buildLayers(true)], { query: "wombat", limit: 5 });
  const singleHits = await searchConcepts([buildLayers(false)], { query: "wombat", limit: 5 });
  assert.equal(spreadHits[0].id, "notes/target");
  assert.equal(singleHits[0].id, "notes/target");
  // The winning section ("a") is identical text in both corpora; if df wrongly
  // counted the term once per SECTION instead of once per CONCEPT, repeating
  // it across three sections would inflate df and shrink idf, changing the
  // score even though the winning section itself never changed.
  assert.ok(
    Object.is(spreadHits[0].score, singleHits[0].score),
    `df must count the concept once regardless of how many of its sections repeat the term: ${spreadHits[0].score} vs ${singleHits[0].score}`,
  );
});
