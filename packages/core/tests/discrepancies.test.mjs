import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONABLE_STATUSES, bestCandidateOf, buildDiscrepancies, buildLinkIndex, candidatesFor, compactDiscrepancy,
  discrepancyRevision, filterDiscrepancies, fingerprint, removeLink, rewriteLinkTarget, summarizeDiscrepancies,
} from "../src/discrepancies.mjs";
import { parseRuleDocument, serializeRuleDocument, suggestDiscrepancyRules } from "../src/discrepancy-rules.mjs";
import { mergeConcepts } from "../src/resolver.mjs";

const concept = {
  id: "decisions/db",
  contributors: [
    { layer: "team", level: 2, updated: "2026-08-01" },
    { layer: "company", level: 0, updated: "2026-07-01" },
  ],
  frontmatter: { title: "Database", type: "decision", owner: "Platform" },
  frontmatterConflicts: [{
    key: "owner",
    winner: { layer: "team", level: 2, updated: "2026-08-01", value: "Platform" },
    contributions: [
      { layer: "team", level: 2, updated: "2026-08-01", value: "Platform" },
      { layer: "company", level: 0, updated: "2026-07-01", value: "Architecture" },
    ],
  }],
  sections: [{
    key: "choice", heading: "## Choice {#choice}", content: "Use Postgres. See [[runbooks/missing]].",
    sourceLayer: "team", sourceUpdated: "2026-08-01",
    conflicts: [{ layer: "company", updated: "2026-07-01", content: "Use MySQL." }],
  }],
};

test("builds section, frontmatter, and settled broken-link discrepancies", () => {
  const result = buildDiscrepancies([concept], { coverageComplete: true });
  assert.deepEqual(result.discrepancies.map((item) => item.kind).sort(), ["broken_link", "frontmatter_value", "section_content"]);
  const section = result.discrepancies.find((item) => item.originalKind === "section_content");
  assert.equal(section.owner, "Platform");
  assert.equal(section.status, "needs_review");
  assert.equal(section.contributions.length, 2);
});

test("frontmatter_value discrepancies preserve a map-valued contribution as a real object", () => {
  // No on-disk YAML syntax in this engine's own parsers produces a genuine
  // map value today (parseYamlScalar only recognizes `[...]` arrays), but
  // buildDiscrepancies operates on whatever a source's already-parsed
  // frontmatter object hands it — a future or foreign adapter that DOES
  // produce a map must not have its shape coerced on the way to a
  // discrepancy row. service.mjs's compose guard depends on exactly this:
  // it refuses compose when `typeof item.value === "object" && item.value
  // !== null`, which only catches a map if this projection leaves it alone
  // (a guard narrowed back to Array.isArray, as it once was, would let a
  // map slip through and let renderScalar mangle it — see service.mjs).
  const mapConcept = {
    ...concept,
    frontmatterConflicts: [{
      key: "review",
      winner: { layer: "team", level: 2, updated: "2026-08-01", value: { approved: true } },
      contributions: [
        { layer: "team", level: 2, updated: "2026-08-01", value: { approved: true } },
        { layer: "company", level: 0, updated: "2026-07-01", value: { approved: false } },
      ],
    }],
  };
  const result = buildDiscrepancies([mapConcept], { coverageComplete: false });
  const review = result.discrepancies.find((item) => item.key === "review");
  assert.ok(review, "expected a frontmatter_value discrepancy for the map field");
  for (const item of review.contributions) {
    assert.equal(Array.isArray(item.value), false);
    assert.deepEqual(item.value, item.effective ? { approved: true } : { approved: false });
  }
  assert.equal(review.contributions.some((item) => typeof item.value === "object" && item.value !== null), true);
});

test("does not manufacture broken links with incomplete coverage", () => {
  const result = buildDiscrepancies([concept], { coverageComplete: false });
  assert.equal(result.discrepancies.some((item) => item.kind === "broken_link"), false);
});

test("an acknowledged discrepancy reopens when a contributor fingerprint changes", () => {
  const decisions = [{
    schemaVersion: 2, id: "d1", discrepancyId: "section_content::decisions/db::choice", action: "acknowledge",
    contributorFingerprints: [
      { source: "team", fingerprint: fingerprint("old") },
      { source: "company", fingerprint: fingerprint("Use MySQL.") },
    ],
  }];
  const result = buildDiscrepancies([concept], { decisions, coverageComplete: false });
  const section = result.discrepancies.find((item) => item.originalKind === "section_content");
  assert.equal(section.kind, "changed_after_decision");
  assert.equal(section.status, "reopened");
});

test("suggestions need three distinct, consistent decisions", () => {
  const pattern = { kind: "section_content", conceptType: "decision", key: "choice", sources: ["company", "team"] };
  const rows = ["a", "b", "c"].map((id) => ({
    schemaVersion: 2, id: `decision-${id}`, discrepancyId: `section_content::${id}::choice`,
    method: "manual", learningPattern: pattern, ruleAction: { type: "prefer_source", source: "team" },
  }));
  assert.equal(suggestDiscrepancyRules(rows.slice(0, 2)).length, 0);
  const [suggestion] = suggestDiscrepancyRules(rows);
  assert.equal(suggestion.evidenceCount, 3);
  assert.equal(suggestion.action.source, "team");
});

test("frontmatter detection excludes resolver mechanics and singly defined fields", () => {
  const merged = mergeConcepts([
    { layer: "team", level: 2, updated: "2026-08-02", frontmatter: { owner: "Platform", updated: "2026-08-02", override: "merge", solo: "normal" }, sections: [] },
    { layer: "company", level: 0, updated: "2026-07-01", frontmatter: { owner: "Architecture", updated: "2026-07-01", override: "full" }, sections: [] },
  ]);
  assert.deepEqual(merged.frontmatterConflicts.map((item) => item.key), ["owner"]);
});

test("revisions are stable across contribution order and change with fingerprints", () => {
  const contributions = [
    { source: "team", level: 2, fingerprint: fingerprint("a") },
    { source: "company", level: 0, fingerprint: fingerprint("b") },
  ];
  assert.equal(discrepancyRevision(contributions), discrepancyRevision([...contributions].reverse()));
  assert.notEqual(discrepancyRevision(contributions), discrepancyRevision([{ ...contributions[0], fingerprint: fingerprint("changed") }, contributions[1]]));
});

test("a reversal disqualifies that discrepancy from learned evidence", () => {
  const pattern = { kind: "section_content", conceptType: "decision", key: "choice", sources: ["company", "team"] };
  const rows = ["a", "b", "c"].flatMap((id) => [{
    schemaVersion: 2, id: `${id}-1`, discrepancyId: id, method: "manual", learningPattern: pattern,
    ruleAction: { type: "prefer_source", source: "team" },
  }, ...(id === "c" ? [{
    schemaVersion: 2, id: `${id}-2`, discrepancyId: id, method: "manual", learningPattern: pattern,
    ruleAction: { type: "prefer_source", source: "company" }, supersedes: `${id}-1`,
  }] : [])]);
  assert.equal(suggestDiscrepancyRules(rows).length, 0);
});

test("conflicting matching rules disable automation and surface the ambiguity", () => {
  const match = { kind: "section_content", conceptType: "decision", key: "choice", sources: ["company", "team"] };
  const rules = ["team", "company"].map((source) => ({ id: source, scope: "local", mode: "automatic", enabled: true, match, action: { type: "prefer_source", source } }));
  const item = buildDiscrepancies([concept], { rules, coverageComplete: false }).discrepancies.find((row) => row.originalKind === "section_content");
  assert.equal(item.ruleConflict, true);
  assert.equal(item.status, "needs_review");
});

test("a resolved section_content decision emits exactly one record, under its canonical id", () => {
  // schemaVersion-2, non-acknowledge, committed decision carrying BOTH the
  // canonical discrepancyId and the legacy conflictId. decisionMap indexes it
  // under both keys, so the resolved-record reconstruction must dedupe by
  // canonical id or this becomes two rows for one resolution (F12).
  const decisions = [{
    schemaVersion: 2, id: "d1",
    discrepancyId: "section_content::decisions/settled::choice",
    conflictId: "decisions/settled::choice",
    action: "choose_contribution", transactionState: "committed",
    conceptId: "decisions/settled", title: "Settled", conceptType: "decision",
    sectionKey: "choice", sectionHeading: "Choice", owner: "Platform",
    chosen: { layer: "team", content: "Use Postgres.", updated: "2026-08-01" },
    contributions: [
      { layer: "team", level: 2, content: "Use Postgres.", updated: "2026-08-01" },
      { layer: "company", level: 0, content: "Use MySQL.", updated: "2026-07-01" },
    ],
  }];
  // No current conflict for this concept — buildDiscrepancies' first pass
  // produces nothing for it, so the decision is only visible through the
  // resolved-record reconstruction loop this test targets.
  const settled = { ...concept, id: "decisions/settled", sections: [], frontmatterConflicts: [] };
  const result = buildDiscrepancies([settled], { decisions, coverageComplete: false });
  const rows = result.discrepancies.filter((item) => item.conceptId === "decisions/settled");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "section_content::decisions/settled::choice");
  assert.equal(rows[0].legacyId, "decisions/settled::choice");
  assert.equal(rows[0].status, "resolved");
});

test("a live section conflict is not duplicated by its own committed decision (both ids present)", () => {
  // schemaVersion-2, non-acknowledge, committed decision carrying BOTH the
  // canonical discrepancyId and the legacy conflictId, for a concept whose
  // section is STILL in conflict — so the first pass emits a live row AND the
  // resolved-record reconstruction loop visits this decision under its legacy
  // key. That legacy key doesn't collide with currentIds, but the canonical id
  // it resolves to does — dedupe has to check the canonical id, or this
  // concept+section ends up with two rows sharing one id (F13).
  const decisions = [{
    schemaVersion: 2, id: "d1",
    discrepancyId: "section_content::decisions/db::choice",
    conflictId: "decisions/db::choice",
    action: "choose_contribution", transactionState: "committed",
    conceptId: "decisions/db", title: "Database", conceptType: "decision",
    sectionKey: "choice", sectionHeading: "Choice", owner: "Platform",
    chosen: { layer: "team", content: "Use Postgres.", updated: "2026-08-01" },
    // Recorded fingerprints differ from what's on disk now, so the live
    // section reopens rather than resolving quietly.
    contributions: [
      { layer: "team", level: 2, content: "Use Postgres.", updated: "2026-08-01" },
      { layer: "company", level: 0, content: "Use MySQL.", updated: "2026-07-01" },
    ],
  }];
  const result = buildDiscrepancies([concept], { decisions, coverageComplete: false });
  const rows = result.discrepancies.filter((item) => item.conceptId === "decisions/db" && item.key === "choice");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "reopened");
  const ids = result.discrepancies.map((item) => item.id);
  assert.equal(ids.length, new Set(ids).size);
});

test("active-discrepancy decoration still finds a decision by its legacy id", () => {
  // finalize() looks a discrepancy's history up by discrepancyId first, then
  // falls back to legacyId — the same fallback the dedupe above must not break.
  const decisions = [{
    schemaVersion: 2, id: "d1", conflictId: "decisions/db::choice", action: "acknowledge", reasonCode: "other",
  }];
  const result = buildDiscrepancies([concept], { decisions, coverageComplete: false });
  const section = result.discrepancies.find((item) => item.originalKind === "section_content");
  assert.equal(section.status, "acknowledged");
});

test("a broken_link rule accepts its single contributing source, requires a pinned target, and only the acknowledge action", () => {
  const rule = {
    id: "r1", scope: "team", mode: "automatic", enabled: true,
    match: { kind: "broken_link", conceptType: "decision", key: "choice", sources: ["team"], target: "runbooks/missing" },
    action: { type: "acknowledge", reasonCode: "target_missing" }, evidenceDecisionIds: ["d1", "d2", "d3"],
  };
  const [parsed] = parseRuleDocument(serializeRuleDocument([rule]));
  assert.deepEqual(parsed.match, rule.match);
  assert.deepEqual(parsed.action, rule.action);
  assert.throws(() => serializeRuleDocument([{ ...rule, action: { type: "prefer_source", source: "team" } }]),
    /has no source to prefer/);
  assert.throws(() => serializeRuleDocument([{ ...rule, match: { ...rule.match, sources: [] } }]),
    /Invalid discrepancy rule match/);
  // The target is what makes a broken-link rule safe to automate — omitting
  // it (or supplying it for a content-conflict kind) is rejected outright.
  assert.throws(() => serializeRuleDocument([{ ...rule, match: { ...rule.match, target: undefined } }]),
    /must name the missing target/);
  assert.throws(() => serializeRuleDocument([{
    id: "r2", scope: "team", mode: "recommend", enabled: true,
    match: { kind: "section_content", conceptType: "decision", key: "choice", sources: ["company", "team"], target: "irrelevant" },
    action: { type: "prefer_source", source: "team" },
  }]), /Only a broken-link rule may name a target/);
});

test("an automatic broken_link acknowledge rule matches its exact target and marks the link auto_ready", () => {
  const rules = [{
    id: "r1", scope: "team", mode: "automatic", enabled: true,
    match: { kind: "broken_link", conceptType: "decision", key: "choice", sources: ["team"], target: "runbooks/missing" },
    action: { type: "acknowledge", reasonCode: "target_missing" },
  }];
  const link = buildDiscrepancies([concept], { rules, coverageComplete: true })
    .discrepancies.find((item) => item.kind === "broken_link");
  assert.equal(link.status, "auto_ready");
  assert.equal(link.ruleConflict, false);
  assert.equal(link.matchingRules[0].action.reasonCode, "target_missing");
});

test("a broken_link rule pinned to one target does not swallow a different dangling link in the same section", () => {
  // Two concepts, same conceptType/key/source, but different missing
  // targets — a rule evidenced against the first must not silently
  // auto-acknowledge the second, unreviewed one (the failure mode a
  // target-blind match would produce: a typo'd link never surfaces).
  const otherConcept = {
    ...concept, id: "decisions/other",
    sections: [{ ...concept.sections[0], content: "Use Postgres. See [[runbooks/typo]].", conflicts: [] }],
    frontmatterConflicts: [],
  };
  const rules = [{
    id: "r1", scope: "team", mode: "automatic", enabled: true,
    match: { kind: "broken_link", conceptType: "decision", key: "choice", sources: ["team"], target: "runbooks/missing" },
    action: { type: "acknowledge", reasonCode: "target_missing" },
  }];
  const links = buildDiscrepancies([concept, otherConcept], { rules, coverageComplete: true })
    .discrepancies.filter((item) => item.kind === "broken_link");
  const matched = links.find((item) => item.target === "runbooks/missing");
  const unrelated = links.find((item) => item.target === "runbooks/typo");
  assert.equal(matched.status, "auto_ready");
  assert.equal(unrelated.status, "needs_review");
  assert.equal(unrelated.matchingRules.length, 0);
});

test("serialized shared rules contain structural metadata only", () => {
  const text = serializeRuleDocument([{
    id: "r1", scope: "local", mode: "automatic", enabled: true,
    match: { kind: "section_content", conceptType: "decision", key: "choice", sources: ["company", "team"] },
    action: { type: "prefer_source", source: "team" }, evidenceDecisionIds: ["d1", "d2", "d3"],
    note: "secret note", content: "secret source content", prompt: "secret prompt",
  }]);
  assert.equal(text.includes("secret"), false);
  assert.match(text, /"mode": "recommend"/);
});

// ---- wire shapes: summarize / compact / filter ----------------------------------

function projectionFixture() {
  const long = "x".repeat(600);
  const concepts = [
    concept,
    { ...concept, id: "decisions/cache", frontmatter: { title: "Cache", type: "decision", owner: "Platform" }, frontmatterConflicts: [],
      sections: [{ key: "choice", heading: "## Choice {#choice}", content: `${long} See [[runbooks/missing]] and [[Runbooks/Postgres]].`, sourceLayer: "team", sourceUpdated: "2026-08-01",
        conflicts: [{ layer: "company", updated: "2026-07-01", content: "Use Redis." }] }] },
    { id: "runbooks/postgres", contributors: [{ layer: "team", level: 2 }], frontmatter: { title: "Postgres", type: "runbook", owner: "Data" }, frontmatterConflicts: [], sections: [] },
    { id: "notes/quiet", contributors: [{ layer: "personal", level: 3 }], frontmatter: { title: "Quiet", type: "note", owner: "Me" }, frontmatterConflicts: [],
      sections: [{ key: "body", heading: "## Body {#body}", content: "Links [[runbooks/missing]].", sourceLayer: "personal", sourceUpdated: "2026-08-02", conflicts: [] }] },
  ];
  const decisions = [{
    schemaVersion: 2, id: "ack-1", discrepancyId: "section_content::decisions/db::choice", action: "acknowledge", reasonCode: "different_scopes",
    decidedAt: "2026-08-03T00:00:00.000Z", transactionState: "not_required",
    contributorFingerprints: [{ source: "team", fingerprint: fingerprint("Use Postgres. See [[runbooks/missing]].") }, { source: "company", fingerprint: fingerprint("Use MySQL.") }],
  }];
  return buildDiscrepancies(concepts, { decisions, coverageComplete: true }).discrepancies;
}

test("summarizeDiscrepancies counts kinds, statuses, groupings, targets, and quick wins", () => {
  const list = projectionFixture();
  const summary = summarizeDiscrepancies(list);
  assert.equal(summary.total, list.length);
  assert.equal(summary.actionable, list.filter((item) => ACTIONABLE_STATUSES.has(item.status)).length);
  assert.equal(summary.byKind.broken_link, 4);
  assert.equal(summary.byKind.section_content, 2);
  assert.equal(summary.byKind.frontmatter_value, 1);
  assert.equal(summary.byStatus.acknowledged, 1);
  assert.equal(summary.byStatus.needs_review, summary.total - 1);
  // Three records share the missing target; the case-slip has a clear best candidate.
  const missing = summary.topTargets.find((row) => row.target === "runbooks/missing");
  assert.equal(missing.count, 3);
  assert.equal(summary.topTargets[0].target, "runbooks/missing");
  assert.equal(missing.bestCandidate, null);
  const cased = summary.topTargets.find((row) => row.target === "Runbooks/Postgres");
  assert.equal(cased.bestCandidate.id, "runbooks/postgres");
  assert.equal(summary.quickWins.brokenLinksTotal, 4);
  assert.equal(summary.quickWins.brokenLinksWithBestCandidate, 1);
  assert.equal(summary.quickWins.autoReady, 0);
  assert.deepEqual(summary.bySourcePair.map((row) => row.key).sort(), ["company|team", "personal", "team"]);
  assert.equal(summary.byOwner.find((row) => row.owner === "Platform").count, 6);
  assert.equal(summary.byConceptType.find((row) => row.conceptType === "decision").count, 6);
  assert.equal(summary.topConcepts[0].count >= summary.topConcepts.at(-1).count, true);
  // topN bounds every list, and the choice of ties is deterministic.
  assert.equal(summarizeDiscrepancies(list, { topN: 1 }).topConcepts.length, 1);
  assert.deepEqual(summarizeDiscrepancies(list), summarizeDiscrepancies([...list].reverse()));
});

test("compactDiscrepancy previews long bodies and folds history into a count plus the latest decision", () => {
  const list = projectionFixture();
  const compact = list.map((item) => compactDiscrepancy(item));
  for (const item of compact) {
    assert.equal(item.compact, true);
    assert.equal("history" in item, false);
    for (const contribution of item.contributions) {
      assert.equal(typeof contribution.truncated, "boolean");
      assert.equal(typeof contribution.valueBytes, "number");
      assert.equal(contribution.value.length <= 240, true, `preview over 240 chars for ${item.id}`);
    }
    if (typeof item.effectiveValue === "string") assert.equal(item.effectiveValue.length <= 240, true);
  }
  const long = compact.find((item) => item.conceptId === "decisions/cache" && item.originalKind === "section_content");
  assert.equal(long.contributions[0].truncated, true);
  assert.equal(long.contributions[0].valueBytes > 600, true);
  assert.equal(long.contributions[0].valueKind, "string");
  assert.equal(long.contributions[1].truncated, false);
  const acked = compact.find((item) => item.status === "acknowledged");
  assert.equal(acked.historyCount, 1);
  assert.deepEqual(acked.latestDecision, { id: "ack-1", action: "acknowledge", decidedAt: "2026-08-03T00:00:00.000Z", transactionState: "not_required", reasonCode: "different_scopes" });
  const fresh = compact.find((item) => item.originalKind === "frontmatter_value");
  assert.equal(fresh.historyCount, 0);
  assert.equal(fresh.latestDecision, null);
  // Structured values keep their kind and are previewed as JSON.
  const listValued = compactDiscrepancy({ ...list[0], contributions: [{ source: "a", value: ["x", "y"] }, { source: "b", value: { k: 1 } }] });
  assert.equal(listValued.contributions[0].valueKind, "list");
  assert.equal(listValued.contributions[0].value, '["x","y"]');
  assert.equal(listValued.contributions[1].valueKind, "map");
  // Never mutates the record it compacts.
  assert.equal(Array.isArray(list[0].history), true);
  assert.equal(typeof list[0].contributions[0].truncated, "undefined");
});

test("filterDiscrepancies narrows by status (with the actionable alias), kind, concept, target, source, owner, and type", () => {
  const list = projectionFixture();
  assert.equal(filterDiscrepancies(list, { status: "actionable" }).every((item) => ACTIONABLE_STATUSES.has(item.status)), true);
  assert.equal(filterDiscrepancies(list, { status: "acknowledged" }).length, 1);
  assert.equal(filterDiscrepancies(list, { status: "all" }).length, list.length);
  assert.equal(filterDiscrepancies(list, { kind: "broken_link" }).length, 4);
  assert.equal(filterDiscrepancies(list, { kind: "broken_link", target: "runbooks/missing" }).length, 3);
  assert.equal(filterDiscrepancies(list, { conceptId: "notes/quiet" }).length, 1);
  assert.equal(filterDiscrepancies(list, { source: "personal" }).length, 1);
  assert.equal(filterDiscrepancies(list, { source: "company" }).length, 3);
  assert.equal(filterDiscrepancies(list, { owner: "Me" }).length, 1);
  assert.equal(filterDiscrepancies(list, { conceptType: "note" }).length, 1);
  assert.deepEqual(filterDiscrepancies(list, {}), list);
});

// ---- broken-link candidates -------------------------------------------------------

function candidateCorpus() {
  return [
    { id: "runbooks/missing-thing", frontmatter: { title: "Missing Thing", type: "runbook" } },
    { id: "decisions/db", frontmatter: { type: "decision" } },
    { id: "decisions/db-two", frontmatter: { type: "decision" } },
    { id: "archive/README", frontmatter: {} },
    { id: "docs/README", frontmatter: {} },
    { id: "guides/Setup Guide", frontmatter: { title: "Setup Guide", type: "guide" } },
  ];
}

test("candidatesFor names one structural reason per rule with the documented confidence", () => {
  const index = buildLinkIndex(candidateCorpus());
  const from = { linkingConceptId: "decisions/db", linkingConceptType: "decision" };
  const only = (target) => { const c = candidatesFor(target, from, index); assert.equal(c.length, 1, `${target}: ${JSON.stringify(c)}`); return c[0]; };
  assert.deepEqual(only("../runbooks/missing-thing"), { id: "runbooks/missing-thing", reason: "relative", confidence: 0.95 });
  assert.deepEqual(only("Runbooks/Missing-Thing"), { id: "runbooks/missing-thing", reason: "case", confidence: 0.95 });
  assert.deepEqual(only("runbooks/missing-thing.mdx"), { id: "runbooks/missing-thing", reason: "extension", confidence: 0.95 });
  assert.deepEqual(only("runbooks/missing_thing"), { id: "runbooks/missing-thing", reason: "slug", confidence: 0.9 });
  assert.deepEqual(only("old/missing-thing"), { id: "runbooks/missing-thing", reason: "moved", confidence: 0.85 });
  assert.deepEqual(only("Missing Thing"), { id: "runbooks/missing-thing", reason: "title", confidence: 0.85 });
  assert.deepEqual(only("old/Missing_Thing"), { id: "runbooks/missing-thing", reason: "slug_moved", confidence: 0.7 });
  // A sibling reference resolves relative to the linking file's folder.
  assert.deepEqual(only("db-two"), { id: "decisions/db-two", reason: "relative", confidence: 0.95 });
  // Typos only when nothing structural matched: one edit, same type → 0.65.
  assert.deepEqual(only("decisions/db-tow"), { id: "decisions/db-two", reason: "typo", confidence: 0.65 });
  // Short basenames tolerate one edit, not two.
  assert.deepEqual(candidatesFor("decisions/xx", from, index), []);
  // Nothing close at all → empty, never a guess.
  assert.deepEqual(candidatesFor("zzz/completely-unrelated", from, index), []);
});

test("bestCandidate needs a confident, unambiguous top; ambiguity yields null and candidates stay ≤5", () => {
  const index = buildLinkIndex(candidateCorpus());
  const from = { linkingConceptId: "decisions/db", linkingConceptType: "decision" };
  const readme = candidatesFor("README", from, index);
  assert.deepEqual(readme.map((c) => [c.id, c.reason, c.confidence]), [["archive/README", "moved", 0.6], ["docs/README", "moved", 0.6]]);
  assert.equal(bestCandidateOf(readme), null);
  assert.equal(bestCandidateOf(candidatesFor("Runbooks/Missing-Thing", from, index)).id, "runbooks/missing-thing");
  assert.equal(bestCandidateOf(candidatesFor("decisions/db-tow", from, index)), null, "a typo is never a best candidate");
  assert.equal(bestCandidateOf([{ id: "a", confidence: 0.95 }, { id: "b", confidence: 0.85 }]), null, "gap under 0.15");
  assert.equal(bestCandidateOf([{ id: "a", confidence: 0.95 }, { id: "b", confidence: 0.6 }]).id, "a");
  assert.equal(bestCandidateOf([]), null);
  const crowded = buildLinkIndex(Array.from({ length: 12 }, (_, i) => ({ id: `dir${i}/shared`, frontmatter: {} })));
  const many = candidatesFor("shared", from, crowded);
  assert.equal(many.length, 5);
  assert.deepEqual(many.map((c) => c.id), [...many.map((c) => c.id)].sort());
});

test("candidate search is memoized per (target, linking folder, linking type) and deterministic across builds", () => {
  const corpus = candidateCorpus();
  const index = buildLinkIndex(corpus);
  const memo = new Map();
  const a = candidatesFor("old/missing-thing", { linkingConceptId: "decisions/db", linkingConceptType: "decision" }, index, memo);
  const b = candidatesFor("old/missing-thing", { linkingConceptId: "decisions/other", linkingConceptType: "decision" }, index, memo);
  const c = candidatesFor("old/missing-thing", { linkingConceptId: "notes/other", linkingConceptType: "decision" }, index, memo);
  assert.equal(a, b, "same folder shares one search");
  assert.notEqual(a, c, "another folder is another key (relative and typo rules read it)");
  assert.deepEqual(a, c);
  assert.equal(memo.size, 2);
  const again = candidatesFor("old/missing-thing", { linkingConceptId: "decisions/db", linkingConceptType: "decision" }, buildLinkIndex([...corpus].reverse()));
  assert.deepEqual(again, a);
});

test("buildDiscrepancies attaches candidates and bestCandidate to broken links without touching revision", () => {
  const linker = {
    ...concept, id: "decisions/linker", frontmatterConflicts: [],
    sections: [{ key: "choice", heading: "## Choice {#choice}", content: "See [[Runbooks/Missing-Thing]] and [[nowhere/at-all]].", sourceLayer: "team", sourceUpdated: "2026-08-01", conflicts: [] }],
  };
  const target = { id: "runbooks/missing-thing", contributors: [{ layer: "team", level: 2 }], frontmatter: { title: "Missing Thing", type: "runbook" }, frontmatterConflicts: [], sections: [] };
  const links = buildDiscrepancies([linker, target], { coverageComplete: true }).discrepancies.filter((item) => item.kind === "broken_link");
  const cased = links.find((item) => item.target === "Runbooks/Missing-Thing");
  assert.deepEqual(cased.candidates, [{ id: "runbooks/missing-thing", reason: "case", confidence: 0.95 }]);
  assert.equal(cased.bestCandidate.id, "runbooks/missing-thing");
  const nowhere = links.find((item) => item.target === "nowhere/at-all");
  assert.deepEqual(nowhere.candidates, []);
  assert.equal(nowhere.bestCandidate, null);
  // Adding a concept that changes the suggestion must not change the revision.
  const withoutTarget = buildDiscrepancies([linker], { coverageComplete: true }).discrepancies.find((item) => item.target === "Runbooks/Missing-Thing");
  assert.deepEqual(withoutTarget.candidates, []);
  assert.equal(withoutTarget.revision, cased.revision);
});

test("candidate search stays bounded: 1,500 dangling links over 3,000 ids, deterministic", () => {
  const ids = Array.from({ length: 3000 }, (_, i) => ({ id: `area-${i % 30}/note-${i}`, contributors: [{ layer: "team", level: 2 }], frontmatter: { type: "note", title: `Note ${i}` }, frontmatterConflicts: [], sections: [] }));
  const linkers = Array.from({ length: 1500 }, (_, i) => ({
    id: `linkers/l-${i}`, contributors: [{ layer: "team", level: 2 }], frontmatter: { type: "note" }, frontmatterConflicts: [],
    sections: [{ key: "body", heading: "## Body {#body}", sourceLayer: "team", sourceUpdated: null, conflicts: [],
      // A mix of shapes: renamed folder, case slip, typo, and hopeless.
      content: i % 4 === 0 ? `[[old/note-${i}]]` : i % 4 === 1 ? `[[Area-${i % 30}/Note-${i}]]` : i % 4 === 2 ? `[[area-${i % 30}/note-${i}x]]` : `[[gone/${i}-nothing-like-it]]` }],
  }));
  const started = process.hrtime.bigint();
  const first = buildDiscrepancies([...ids, ...linkers], { coverageComplete: true }).discrepancies.filter((item) => item.kind === "broken_link");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(first.length, 1500);
  assert.equal(elapsedMs < 1500, true, `candidate search took ${elapsedMs.toFixed(0)}ms`);
  const second = buildDiscrepancies([...ids, ...linkers], { coverageComplete: true }).discrepancies.filter((item) => item.kind === "broken_link");
  assert.deepEqual(second.map((item) => [item.id, item.candidates, item.bestCandidate]), first.map((item) => [item.id, item.candidates, item.bestCandidate]));
  assert.equal(first.filter((item) => item.bestCandidate).length >= 750, true, "renames and case slips resolve to a best candidate");
});

// ---- link text helpers -------------------------------------------------------------

test("rewriteLinkTarget preserves ./, .md, #anchor, whitespace, and wikilink aliases; skips images and other targets", () => {
  const text = "See [x](./runbooks/missing.md#setup), [[runbooks/missing|Alias]], [[runbooks/missing#sec]], [y]( runbooks/missing ), ![img](runbooks/missing), [z](runbooks/other), [w](https://example.com/runbooks/missing).";
  const { text: out, replaced } = rewriteLinkTarget(text, "runbooks/missing", "runbooks/found");
  assert.equal(replaced, 4);
  assert.equal(out, "See [x](./runbooks/found.md#setup), [[runbooks/found|Alias]], [[runbooks/found#sec]], [y]( runbooks/found ), ![img](runbooks/missing), [z](runbooks/other), [w](https://example.com/runbooks/missing).");
  assert.deepEqual(rewriteLinkTarget("no links here", "a", "b"), { text: "no links here", replaced: 0 });
  assert.deepEqual(rewriteLinkTarget("[x](a)", "b", "c"), { text: "[x](a)", replaced: 0 });
});

test("removeLink turns links into their label, alias, or basename; images and other targets survive", () => {
  const text = "See [the runbook](./runbooks/missing.md#setup), [[runbooks/missing|Alias]], [[runbooks/missing]], ![img](runbooks/missing), [z](runbooks/other).";
  const { text: out, replaced } = removeLink(text, "runbooks/missing");
  assert.equal(replaced, 3);
  assert.equal(out, "See the runbook, Alias, missing, ![img](runbooks/missing), [z](runbooks/other).");
  assert.deepEqual(removeLink("[[Missing Runbook]]", "Missing Runbook"), { text: "Missing Runbook", replaced: 1 });
});
