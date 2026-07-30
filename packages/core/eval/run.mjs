#!/usr/bin/env node

// Retrieval eval. Scores search.mjs against a golden question set over a
// committed three-layer corpus, and checks that resolving the answer still
// surfaces the layers that disagree.
//
// Every other suite in this repo tests mechanism: does the merge pick the right
// section, does the walk stay bounded. None of them can answer "would an agent
// find the right concept from a question a person actually typed". This does.
//
//   node packages/core/eval/run.mjs                        # report + compare to baseline.json
//   node packages/core/eval/run.mjs --record --label "..." # rewrite baseline.json
//   node packages/core/eval/run.mjs --json                 # machine-readable
//   node packages/core/eval/run.mjs --verbose              # show what each miss returned instead
//
// Exits nonzero when a metric falls below the recorded baseline: retrieval
// quality is a thing you can regress silently, so it is a build gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSources } from "../src/sources/index.mjs";
import { resolveConcept } from "../src/resolver.mjs";
import { searchConcepts } from "../src/search.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(HERE, "baseline.json");
const CUTOFF = 5; // recall@5: an agent realistically reads the top few hits

// A metric may drift down by this much without failing. Ranking has ties, and a
// 38-question set moves in ~2.6% steps; anything smaller is noise, anything
// larger is a real question flipping from hit to miss.
const TOLERANCE = 0.001;

const argv = process.argv.slice(2);
const args = new Set(argv);
const label = argv[argv.indexOf("--label") + 1];

const { questions } = readJson(path.join(HERE, "questions.json"));
const manifest = readJson(path.join(HERE, "manifest.json"));
const layers = buildSources(manifest, HERE);

try {
  const results = [];
  for (const question of questions) {
    const hits = await searchConcepts(layers, { query: question.question, limit: CUTOFF });
    const rank = hits.findIndex((hit) => question.expect.includes(hit.id)) + 1; // 0 = miss
    results.push({
      ...question,
      rank,
      hits: hits.map((hit) => hit.id),
      conflictOutcome: question.conflict ? await checkConflict(question.conflict) : null,
    });
  }

  const metrics = summarize(results);

  if (args.has("--json")) {
    console.log(JSON.stringify({ metrics, results }, null, 2));
  } else {
    report(results, metrics);
  }

  if (args.has("--record")) {
    if (!label || label === "--record") {
      console.error("--record needs --label \"<what changed>\" so the history says why the number moved.");
      process.exit(1);
    }
    record(metrics, results.length, label);
    console.log(`\nBaseline written to ${path.relative(process.cwd(), BASELINE_PATH)}`);
    process.exit(0);
  }

  process.exit(compareToBaseline(metrics) ? 0 : 1);
} finally {
  for (const layer of layers) layer.close();
}

// ---- scoring ---------------------------------------------------------------

// The claim ContextCake makes over a flat wiki is that disagreement survives
// retrieval. Finding the concept is only half of it: the resolved concept has to
// still carry the dissenting layers, or the answer is just the top layer's
// opinion wearing a provenance badge.
async function checkConflict({ concept, layers: expectedLayers }) {
  const resolved = await resolveConcept(concept, layers);
  if (!resolved) return { pass: false, reason: `concept not found: ${concept}` };

  const seen = new Set();
  for (const section of resolved.sections) {
    for (const conflict of section.conflicts ?? []) seen.add(conflict.layer);
  }
  const missing = expectedLayers.filter((layer) => !seen.has(layer));
  return missing.length === 0
    ? { pass: true, surfaced: [...seen] }
    : { pass: false, reason: `no dissent surfaced from: ${missing.join(", ")}`, surfaced: [...seen] };
}

function summarize(results) {
  const total = results.length;
  const hitsAt = (n) => results.filter((r) => r.rank > 0 && r.rank <= n).length / total;
  const mrr = results.reduce((sum, r) => sum + (r.rank > 0 ? 1 / r.rank : 0), 0) / total;

  const conflictChecks = results.filter((r) => r.conflictOutcome);
  const conflictRate = conflictChecks.length === 0
    ? 1
    : conflictChecks.filter((r) => r.conflictOutcome.pass).length / conflictChecks.length;

  return {
    "recall@1": round(hitsAt(1)),
    [`recall@${CUTOFF}`]: round(hitsAt(CUTOFF)),
    mrr: round(mrr),
    conflict: round(conflictRate),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// ---- output ----------------------------------------------------------------

function report(results, metrics) {
  const verbose = args.has("--verbose");

  console.log(`\nRetrieval eval — ${results.length} questions over ${layers.length} layers\n`);

  const misses = results.filter((r) => r.rank === 0);
  const demoted = results.filter((r) => r.rank > 1);
  const conflictFails = results.filter((r) => r.conflictOutcome && !r.conflictOutcome.pass);

  if (misses.length) {
    console.log(`Not found in the top ${CUTOFF} (${misses.length}):`);
    for (const miss of misses) {
      console.log(`  ${miss.id}  "${miss.question}"`);
      console.log(`        want ${miss.expect.join(" | ")}`);
      console.log(`        got  ${miss.hits.length ? miss.hits.join(", ") : "(nothing)"}`);
      if (verbose) console.log(`        probes: ${miss.probes}`);
    }
    console.log("");
  }

  if (demoted.length) {
    console.log(`Found, but not first (${demoted.length}):`);
    for (const hit of demoted) {
      console.log(`  ${hit.id}  rank ${hit.rank}  "${hit.question}"  → beaten by ${hit.hits[0]}`);
    }
    console.log("");
  }

  if (conflictFails.length) {
    console.log(`Conflicts not surfaced (${conflictFails.length}):`);
    for (const fail of conflictFails) {
      console.log(`  ${fail.id}  ${fail.conflict.concept}: ${fail.conflictOutcome.reason}`);
    }
    console.log("");
  }

  for (const [name, value] of Object.entries(metrics)) {
    console.log(`  ${name.padEnd(10)} ${value.toFixed(3)}`);
  }
}

// The superseded numbers stay in the file. A retrieval change that trades one
// metric for another is a judgement call, and the next person deserves to see
// what the trade actually was rather than one row of current state.
function record(metrics, questionCount, why) {
  const previous = fs.existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH) : null;
  const history = previous ? [{ label: previous.label, ...stripMeta(previous) }, ...(previous.history ?? [])] : [];
  const next = { label: why, questions: questionCount, ...metrics, history };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

function stripMeta({ label, history, ...rest }) {
  return rest;
}

function compareToBaseline(metrics) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log("\nNo baseline recorded. Run with --record to set one.");
    return true;
  }

  const baseline = readJson(BASELINE_PATH);
  const regressions = [];
  const improvements = [];
  for (const [name, value] of Object.entries(metrics)) {
    const before = baseline[name];
    if (typeof before !== "number") continue;
    if (value < before - TOLERANCE) regressions.push(`${name}: ${before.toFixed(3)} → ${value.toFixed(3)}`);
    else if (value > before + TOLERANCE) improvements.push(`${name}: ${before.toFixed(3)} → ${value.toFixed(3)}`);
  }

  if (improvements.length) console.log(`\nImproved: ${improvements.join(", ")}`);
  if (regressions.length) {
    console.log(`\nRETRIEVAL REGRESSED: ${regressions.join(", ")}`);
    console.log("If the change is intentional, re-record with --record and say why in the commit.");
    return false;
  }
  console.log("\neval ok (no regression against baseline)");
  return true;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
