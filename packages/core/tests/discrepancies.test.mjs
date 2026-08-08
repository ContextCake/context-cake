import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscrepancies, discrepancyRevision, fingerprint } from "../src/discrepancies.mjs";
import { serializeRuleDocument, suggestDiscrepancyRules } from "../src/discrepancy-rules.mjs";
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
