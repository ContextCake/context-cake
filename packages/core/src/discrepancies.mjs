// Structural discrepancy projection over resolved concepts. This module never
// changes resolver precedence and never performs semantic/model inference.

import { createHash } from "node:crypto";

export const DISCREPANCY_KINDS = new Set([
  "section_content", "frontmatter_value", "broken_link", "changed_after_decision",
]);

export function fingerprint(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function discrepancyRevision(contributions) {
  return fingerprint(contributions
    .map((item) => [item.source, item.level, item.fingerprint])
    .sort(([a], [b]) => String(a).localeCompare(String(b))));
}

export function buildDiscrepancies(concepts, {
  decisions = [], coverageComplete = true, sourceHealth = [], priorities = {}, rules = [],
} = {}) {
  const out = [];
  const ids = new Set(concepts.map((concept) => concept.id));
  const healthBySource = new Map(sourceHealth.map((source) => [source.name, source]));
  const decisionsById = decisionMap(decisions);

  for (const concept of concepts) {
    const owner = String(concept.frontmatter?.owner ?? "Unassigned");
    const conceptType = String(concept.frontmatter?.type ?? "concept");
    const levels = new Map(concept.contributors.map((item) => [item.layer, item.level]));

    for (const section of concept.sections) {
      if (section.conflicts?.length) {
        const baseKind = "section_content";
        const baseId = `${baseKind}::${concept.id}::${section.key}`;
        const contributions = [
          contribution(section.sourceLayer, levels.get(section.sourceLayer), section.sourceUpdated, section.content, true),
          ...section.conflicts.map((item) => contribution(item.layer, levels.get(item.layer), item.updated, item.content, false)),
        ];
        out.push(finalize({
          id: baseId, legacyId: `${concept.id}::${section.key}`, kind: baseKind,
          conceptId: concept.id, conceptTitle: String(concept.frontmatter?.title ?? concept.id), conceptType,
          key: section.key, label: headingText(section.heading) || section.key, owner,
          effectiveSource: section.sourceLayer, effectiveValue: section.content,
          winnerReason: `${section.sourceLayer} wins by configured layer precedence.`,
          contributions, fresherDissent: section.fresherDissent === true,
          sourceHealth: contributions.map((item) => healthSummary(healthBySource.get(item.source))),
          priority: priorities[baseId] ?? "unassigned",
        }, decisionsById, rules));
      }

      if (coverageComplete) {
        for (const target of extractLinks(section.content)) {
          if (ids.has(target)) continue;
          const id = `broken_link::${concept.id}::${section.key}::${target}`;
          const contributions = [contribution(section.sourceLayer, levels.get(section.sourceLayer), section.sourceUpdated, target, true)];
          out.push(finalize({
            id, kind: "broken_link", conceptId: concept.id,
            conceptTitle: String(concept.frontmatter?.title ?? concept.id), conceptType,
            key: section.key, label: `Missing link target: ${target}`, target, owner,
            effectiveSource: section.sourceLayer, effectiveValue: target,
            winnerReason: "The effective section links to a concept that no settled source provides.",
            contributions, fresherDissent: false,
            sourceHealth: contributions.map((item) => healthSummary(healthBySource.get(item.source))),
            priority: priorities[id] ?? "unassigned",
          }, decisionsById, rules));
        }
      }
    }

    for (const conflict of concept.frontmatterConflicts ?? []) {
      const id = `frontmatter_value::${concept.id}::${conflict.key}`;
      const contributions = conflict.contributions.map((item) => contribution(
        item.layer, item.level, item.updated, item.value, item.layer === conflict.winner.layer,
      ));
      out.push(finalize({
        id, kind: "frontmatter_value", conceptId: concept.id,
        conceptTitle: String(concept.frontmatter?.title ?? concept.id), conceptType,
        key: conflict.key, label: conflict.key, owner,
        effectiveSource: conflict.winner.layer, effectiveValue: conflict.winner.value,
        winnerReason: `${conflict.winner.layer} wins by configured layer precedence.`,
        contributions, fresherDissent: false,
        sourceHealth: contributions.map((item) => healthSummary(healthBySource.get(item.source))),
        priority: priorities[id] ?? "unassigned",
      }, decisionsById, rules));
    }
  }
  // A completed write removes the structural disagreement from the resolver's
  // current output. Keep its evidence discoverable from the append-only log so
  // "resolved" never means "forgotten". A current finding always wins this
  // projection (including a reopened finding after a later source edit).
  // decisionMap indexes a decision under BOTH its canonical discrepancyId and
  // its legacy conflictId, so this loop would otherwise visit the same decided
  // discrepancy twice and emit two resolved rows for one resolution. Dedupe on
  // the canonical id — discrepancyId when the decision recorded one, else the
  // map key itself.
  const currentIds = new Set(out.map((item) => item.id));
  const seenCanonical = new Set();
  for (const [id, history] of decisionsById) {
    if (!id.includes("::") || currentIds.has(id)) continue;
    const latest = history.at(-1);
    if (latest?.schemaVersion !== 2 || latest.action === "acknowledge") continue;
    const canonicalId = latest.discrepancyId ?? id;
    // A current finding always wins this projection (including a reopened
    // finding after a later source edit) — decisionsById indexes the same
    // decision under both discrepancyId and the legacy conflictId, so a
    // decision whose legacy key merely doesn't collide with `currentIds` (the
    // canonical id it resolves to does) must still be skipped here, or the
    // live row above and this resolved-history row emit the same id twice.
    if (seenCanonical.has(canonicalId) || currentIds.has(canonicalId)) continue;
    seenCanonical.add(canonicalId);
    const contributions = (latest.contributions ?? []).map((item) => contribution(
      item.layer, item.level, item.updated, item.content, item.layer === latest.chosen?.layer,
    ));
    out.push({
      id: canonicalId, legacyId: latest.conflictId, kind: latest.discrepancyKind ?? "section_content",
      originalKind: latest.discrepancyKind ?? "section_content", conceptId: latest.conceptId,
      conceptTitle: latest.title ?? latest.conceptId, conceptType: latest.conceptType ?? "concept",
      key: latest.sectionKey ?? latest.fieldKey ?? latest.linkTarget ?? "unknown",
      label: latest.sectionHeading ?? latest.fieldKey ?? latest.linkTarget ?? "Resolved discrepancy",
      owner: latest.owner ?? "Unassigned", effectiveSource: latest.chosen?.layer ?? null,
      effectiveValue: latest.chosen?.content ?? latest.reconciledContent ?? null,
      winnerReason: "This value was established by the recorded decision.", contributions,
      revision: latest.revision, fresherDissent: false, sourceHealth: [], priority: latest.priority ?? "unassigned",
      freshness: { effectiveUpdated: latest.chosen?.updated ?? null, newestUpdated: newestDate(contributions.map((entry) => entry.updated)), hasNewerDissent: false },
      affectedLinks: [...new Set(contributions.flatMap((entry) => typeof entry.value === "string" ? extractLinks(entry.value) : []))],
      status: latest.transactionState === "committed" || latest.transactionState === "not_required" ? "resolved" : "blocked",
      history, matchingRules: [],
    });
  }
  return { discrepancies: out, coverageComplete };
}

function finalize(item, decisionsById, rules) {
  item.originalKind = item.kind;
  item.freshness = {
    effectiveUpdated: item.contributions.find((entry) => entry.effective)?.updated ?? null,
    newestUpdated: newestDate(item.contributions.map((entry) => entry.updated)),
    hasNewerDissent: item.fresherDissent === true,
  };
  item.affectedLinks = [...new Set(item.contributions.flatMap((entry) => typeof entry.value === "string" ? extractLinks(entry.value) : []))];
  item.revision = discrepancyRevision(item.contributions);
  const history = decisionsById.get(item.id) ?? decisionsById.get(item.legacyId) ?? [];
  const latest = history.at(-1) ?? null;
  const recorded = latest?.contributorFingerprints ?? latest?.contributions?.map((c) => ({ source: c.layer, fingerprint: fingerprint(c.content) }));
  const changed = Boolean(latest && recorded && !sameFingerprints(recorded, item.contributions));
  const ruleMatch = matchRules(item, rules);
  const matchingRules = ruleMatch.rules;
  item.kind = changed ? "changed_after_decision" : item.kind;
  item.status = changed ? "reopened"
    : latest?.action === "acknowledge" ? "acknowledged"
      : !ruleMatch.conflict && matchingRules.some((rule) => rule.mode === "automatic") ? "auto_ready"
        : !ruleMatch.conflict && matchingRules.length ? "recommended" : "needs_review";
  item.history = history;
  item.matchingRules = matchingRules.map(publicRule);
  item.ruleConflict = ruleMatch.conflict;
  return item;
}

function contribution(source, level, updated, value, effective) {
  return { source, level: level ?? 0, updated: updated ?? null, value, fingerprint: fingerprint(value), effective };
}

function decisionMap(decisions) {
  const map = new Map();
  for (const decision of decisions) {
    const keys = [decision.discrepancyId, decision.conflictId].filter(Boolean);
    for (const key of keys) {
      const rows = map.get(key) ?? [];
      rows.push(decision);
      map.set(key, rows);
    }
  }
  return map;
}

function sameFingerprints(recorded, current) {
  const a = recorded.map((x) => `${x.source ?? x.layer}:${x.fingerprint}`).sort();
  const b = current.map((x) => `${x.source}:${x.fingerprint}`).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function matchRules(item, rules) {
  const sources = item.contributions.map((c) => c.source).sort().join("|");
  const matches = rules.filter((rule) => rule.enabled !== false
    && rule.match?.kind === item.kind
    && rule.match?.conceptType === item.conceptType
    && rule.match?.key === item.key
    // A broken_link rule is pinned to the exact target it was evidenced
    // against — matching by section alone would auto-acknowledge any other
    // dangling link that happens to share a concept type and section.
    && (item.kind !== "broken_link" || rule.match?.target === item.target)
    && [...(rule.match?.sources ?? [])].sort().join("|") === sources);
  const actions = new Set(matches.map((rule) => stable(rule.action)));
  return { rules: matches, conflict: actions.size > 1 };
}

function publicRule(rule) {
  return { id: rule.id, scope: rule.scope, mode: rule.mode, action: rule.action, evidenceDecisionIds: rule.evidenceDecisionIds ?? [] };
}

function extractLinks(text) {
  const out = [];
  for (const match of String(text).matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    if (!match[0].startsWith("!") && localTarget(match[1])) out.push(cleanTarget(match[1]));
  }
  for (const match of String(text).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g)) {
    if (localTarget(match[1])) out.push(cleanTarget(match[1]));
  }
  return [...new Set(out.filter(Boolean))];
}

function localTarget(target) { return !/^[a-z][a-z0-9+.-]*:/i.test(String(target)) && !String(target).startsWith("#"); }
function cleanTarget(target) { return String(target).split("#")[0].replace(/^\.\//, "").replace(/\.md$/i, "").trim(); }
function headingText(value) { return String(value ?? "").replace(/^#+\s*/, "").replace(/\s*\{#.*\}\s*$/, "").trim(); }
function healthSummary(source) { return source ? { source: source.name, status: source.status, error: source.error ?? null } : null; }
function newestDate(values) {
  return values.filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
}
function stable(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
