import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscrepancies, discrepancyRevision, fingerprint } from "../src/discrepancies.mjs";
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
