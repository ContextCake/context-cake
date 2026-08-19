// Discrepancy rules: the structural policy a person approves from evidence
// (three consistent manual decisions), stored per profile and optionally
// promoted into the live team layer as recommendations. A rule matches on
// `kind`, `conceptType`, `key`, `sources`, and — for a broken link — the exact
// `target`; for a broken-link rule only, `conceptType` and `key` may be the
// literal wildcard "*" when the evidence spanned several sections (the exact
// target still pins it), `target` never is. Actions are
// `prefer_source` (content conflicts), `acknowledge`, and `rewrite_link`
// (broken links only). Rules hold structural metadata and decision ids —
// never content, notes, or prompts.

import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeConceptId } from "./sources/okf-local.mjs";
import { ensureSidecarMigrated, sidecarDir } from "./sidecar-state.mjs";

const VERSION = 1;
export const RULE_WILDCARD = "*";
// A generalized broken-link suggestion needs its evidence to reach across
// this many distinct (conceptType, key) pairs — one section repeated three
// times is a pattern for THAT section, not for the target.
const GENERALIZE_MIN_PAIRS = 2;
const SUGGESTION_MIN_EVIDENCE = 3;

export function createDiscrepancyRuleStore(manifestPath, { profileId = "default" } = {}) {
  const dir = sidecarDir(manifestPath, profileId);
  const file = path.join(dir, "discrepancy-rules.json");

  async function list() {
    await ensureSidecarMigrated(manifestPath);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      return parsed?.version === VERSION && Array.isArray(parsed.rules) ? parsed.rules.map(validateRule) : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`Discrepancy rules are unreadable: ${error.message}`);
    }
  }

  async function save(rules) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify({ version: VERSION, rules }, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temp, file);
  }

  async function create(input) {
    const rules = await list();
    // The API accepts only the structural contract. Content, notes, excerpts,
    // prompts, and arbitrary caller metadata must never enter a rule file.
    const rule = validateRule({
      id: randomUUID(), scope: "local", mode: "recommend", enabled: true,
      createdAt: new Date().toISOString(),
      match: input?.match, action: input?.action,
      evidenceDecisionIds: input?.evidenceDecisionIds,
    });
    rules.push(rule);
    await save(rules);
    return rule;
  }

  async function patch(id, changes) {
    const rules = await list();
    const index = rules.findIndex((rule) => rule.id === id);
    if (index === -1) throw Object.assign(new Error("Discrepancy rule not found"), { status: 404 });
    const allowed = {};
    if (changes.mode === "recommend" || changes.mode === "automatic") allowed.mode = changes.mode;
    if (typeof changes.enabled === "boolean") allowed.enabled = changes.enabled;
    rules[index] = validateRule({ ...rules[index], ...allowed, updatedAt: new Date().toISOString() });
    await save(rules);
    return rules[index];
  }

  async function setLocalOverride(teamRule, changes) {
    const rules = await list();
    const index = rules.findIndex((rule) => rule.id === teamRule.id);
    const base = index === -1 ? { ...teamRule, scope: "local", createdAt: new Date().toISOString() } : rules[index];
    const next = validateRule({
      ...base,
      ...(changes.mode === "recommend" || changes.mode === "automatic" ? { mode: changes.mode } : {}),
      ...(typeof changes.enabled === "boolean" ? { enabled: changes.enabled } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (index === -1) rules.push(next); else rules[index] = next;
    await save(rules);
    return next;
  }

  return { file, list, create, patch, setLocalOverride };
}

export function parseRuleDocument(text) {
  const parsed = JSON.parse(text);
  if (parsed?.version !== VERSION || !Array.isArray(parsed.rules)) throw new Error("Unsupported discrepancy rule document");
  return parsed.rules.map((rule) => validateRule({ ...rule, scope: "team", mode: "recommend" }));
}

export function serializeRuleDocument(rules) {
  return `${JSON.stringify({ version: VERSION, rules: rules.map((rule) => validateRule({ ...rule, scope: "team", mode: "recommend" })) }, null, 2)}\n`;
}

/**
 * Mine the decision log for rule suggestions. Two shapes come out:
 *
 * - EXACT: three or more distinct discrepancies sharing one learningPattern
 *   (kind, conceptType, key, sources, and a broken link's target) decided the
 *   same way → a rule with exactly that match.
 * - GENERALIZED (`generalized: true`): for broken links only, three or more
 *   consistent `acknowledge`/`rewrite_link` decisions against the same
 *   (sources, target) that span at least two distinct (conceptType, key)
 *   pairs → a rule matching `conceptType: "*", key: "*"` for that target.
 *   "All links to `old/decisions` from the team layer" is a fact about the
 *   target, and the evidence has to show it reaching across sections before
 *   the suggestion says so. The target itself is never wildcarded.
 *
 * A discrepancy whose latest decision reverses an earlier one is evidence for
 * nothing; automatic decisions are never evidence; a suggestion whose match an
 * existing rule already has is not offered again.
 */
export function suggestDiscrepancyRules(decisions, existing = []) {
  const latestByDiscrepancy = new Map();
  const contradictory = new Set();
  for (const row of decisions) {
    if (row.schemaVersion !== 2 || row.method === "automatic" || !row.learningPattern || !row.ruleAction) continue;
    const prior = latestByDiscrepancy.get(row.discrepancyId);
    if (prior && JSON.stringify(prior.ruleAction) !== JSON.stringify(row.ruleAction)) contradictory.add(row.discrepancyId);
    latestByDiscrepancy.set(row.discrepancyId, row);
  }
  const groups = new Map();
  const generalizable = new Map(); // "sources|target" -> rows
  for (const row of latestByDiscrepancy.values()) {
    if (contradictory.has(row.discrepancyId)) continue;
    const key = JSON.stringify(row.learningPattern);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    const pattern = row.learningPattern;
    if (pattern.kind === "broken_link" && typeof pattern.target === "string" && pattern.target
      && (row.ruleAction.type === "acknowledge" || row.ruleAction.type === "rewrite_link")) {
      const gKey = JSON.stringify([[...(pattern.sources ?? [])].sort(), pattern.target]);
      const bucket = generalizable.get(gKey) ?? [];
      bucket.push(row);
      generalizable.set(gKey, bucket);
    }
  }
  const existingPatterns = new Set(existing.map((rule) => JSON.stringify(rule.match)));
  const suggestions = [];
  const offer = (match, rows, extra = {}) => {
    const key = JSON.stringify(match);
    const distinct = [...new Map(rows.map((row) => [row.discrepancyId, row])).values()];
    if (distinct.length < SUGGESTION_MIN_EVIDENCE || existingPatterns.has(key)) return;
    const actions = new Set(distinct.map((row) => JSON.stringify(row.ruleAction)));
    if (actions.size !== 1) return;
    suggestions.push({
      id: `suggestion:${Buffer.from(key).toString("base64url").slice(0, 24)}`,
      match, action: distinct[0].ruleAction,
      evidenceDecisionIds: distinct.map((row) => row.id), evidenceCount: distinct.length,
      ...extra,
    });
  };
  for (const [key, rows] of groups) offer(JSON.parse(key), rows);
  for (const rows of generalizable.values()) {
    const pairs = new Set(rows.map((row) => JSON.stringify([row.learningPattern.conceptType, row.learningPattern.key])));
    if (pairs.size < GENERALIZE_MIN_PAIRS) continue;
    const { sources, target } = rows[0].learningPattern;
    // Same key order validateRule emits, so "an equivalent rule exists" is a
    // string compare against the stored match.
    offer({ kind: "broken_link", conceptType: RULE_WILDCARD, key: RULE_WILDCARD, sources: [...new Set(sources)].sort(), target }, rows, { generalized: true });
  }
  return suggestions;
}

function validateRule(rule) {
  if (!rule || typeof rule.id !== "string" || !rule.match || !rule.action) throw new Error("Invalid discrepancy rule");
  if (rule.mode !== "recommend" && rule.mode !== "automatic") throw new Error("Invalid discrepancy rule mode");
  const { kind, conceptType, key, sources, target } = rule.match;
  const isBrokenLink = kind === "broken_link";
  // A broken link has exactly one contributing source (the section that
  // links out) rather than two-plus contributors disagreeing, so it can't
  // meet the multi-source minimum the content-conflict kinds require.
  const minSources = isBrokenLink ? 1 : 2;
  if (!["section_content", "frontmatter_value", "broken_link"].includes(kind)
    || typeof conceptType !== "string" || !conceptType
    || typeof key !== "string" || !key
    || !Array.isArray(sources) || sources.length < minSources
    || sources.some((source) => typeof source !== "string" || !source)) {
    throw new Error("Invalid discrepancy rule match");
  }
  // A broken link's identity IS the missing target, unlike section_content/
  // frontmatter_value where the same key recurring across concepts of a type
  // is itself the meaningful pattern. Without pinning the target, a rule
  // would auto-acknowledge any future, unrelated dangling link in that
  // section — including a genuine typo nobody has reviewed. `conceptType` and
  // `key` may generalize to "*" (evidence across sections); the target may
  // not: a wildcard target is exactly that failure.
  if (isBrokenLink && (typeof target !== "string" || !target)) throw new Error("A broken-link rule must name the missing target");
  if (isBrokenLink && target === RULE_WILDCARD) throw new Error("A broken-link rule must name the missing target — the target is never a wildcard");
  if (!isBrokenLink && target !== undefined) throw new Error("Only a broken-link rule may name a target");
  // A wildcard needs something else to pin the rule to. A broken-link rule
  // still has its exact target; a section_content / frontmatter_value rule
  // with `*` on both fields would be pinned by kind and sources alone — one
  // switch to automatic and it overwrites every disagreement between those
  // two layers, sight unseen.
  if (!isBrokenLink && (conceptType === RULE_WILDCARD || key === RULE_WILDCARD)) {
    throw new Error("Only a broken-link rule may use the wildcard * for conceptType or key");
  }
  let action;
  if (rule.action.type === "prefer_source") {
    // service.mjs 409s a prefer_source (choose_contribution) decision against
    // a broken_link discrepancy — there's no alternate source to prefer, only
    // the one dangling link — so a rule offering it would validate here and
    // then never be able to auto-apply.
    if (isBrokenLink) throw new Error("A broken link has no source to prefer — acknowledge it instead");
    if (typeof rule.action.source !== "string" || !sources.includes(rule.action.source)) throw new Error("Invalid preferred source");
    action = { type: "prefer_source", source: rule.action.source };
  } else if (rule.action.type === "acknowledge") {
    if (!["different_scopes", "temporary_migration", "source_specific_authority", "target_missing", "other"].includes(rule.action.reasonCode)) {
      throw new Error("Invalid acknowledgement reason");
    }
    action = { type: "acknowledge", reasonCode: rule.action.reasonCode };
  } else if (rule.action.type === "rewrite_link") {
    // Only a broken link has a link to point elsewhere; the destination is a
    // normalized concept id that differs from the missing target (a rewrite
    // to itself would be a no-op that reports success).
    if (!isBrokenLink) throw new Error("Only a broken-link rule may rewrite a link");
    if (typeof rule.action.newTarget !== "string" || !rule.action.newTarget.trim() || rule.action.newTarget === RULE_WILDCARD) {
      throw new Error("A rewrite_link rule must name the concept the link should point at");
    }
    let newTarget;
    try { newTarget = normalizeConceptId(rule.action.newTarget.trim()); }
    catch { throw new Error("Invalid rewrite_link destination"); }
    if (newTarget === target) throw new Error("A rewrite_link rule must point somewhere other than the missing target");
    action = { type: "rewrite_link", newTarget };
  } else throw new Error("Invalid discrepancy rule action");
  if (rule.evidenceDecisionIds !== undefined
    && (!Array.isArray(rule.evidenceDecisionIds) || rule.evidenceDecisionIds.some((id) => typeof id !== "string"))) {
    throw new Error("Invalid discrepancy rule evidence");
  }
  return {
    id: rule.id, scope: rule.scope === "team" ? "team" : "local",
    mode: rule.mode, enabled: rule.enabled !== false,
    match: { kind, conceptType, key, sources: [...new Set(sources)].sort(), ...(isBrokenLink ? { target } : {}) },
    action,
    evidenceDecisionIds: [...new Set(rule.evidenceDecisionIds ?? [])],
    ...(typeof rule.createdAt === "string" ? { createdAt: rule.createdAt } : {}),
    ...(typeof rule.updatedAt === "string" ? { updatedAt: rule.updatedAt } : {}),
  };
}
