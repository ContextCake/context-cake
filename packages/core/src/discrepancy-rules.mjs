import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const VERSION = 1;

export function createDiscrepancyRuleStore(manifestPath) {
  const dir = path.join(path.dirname(path.resolve(manifestPath)), ".contextcake");
  const file = path.join(dir, "discrepancy-rules.json");

  async function list() {
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
  for (const row of latestByDiscrepancy.values()) {
    if (contradictory.has(row.discrepancyId)) continue;
    const key = JSON.stringify(row.learningPattern);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const existingPatterns = new Set(existing.map((rule) => JSON.stringify(rule.match)));
  const suggestions = [];
  for (const [key, rows] of groups) {
    const distinct = [...new Map(rows.map((row) => [row.discrepancyId, row])).values()];
    if (distinct.length < 3 || existingPatterns.has(key)) continue;
    const actions = new Set(distinct.map((row) => JSON.stringify(row.ruleAction)));
    if (actions.size !== 1) continue;
    suggestions.push({
      id: `suggestion:${Buffer.from(key).toString("base64url").slice(0, 24)}`,
      match: JSON.parse(key), action: distinct[0].ruleAction,
      evidenceDecisionIds: distinct.map((row) => row.id), evidenceCount: distinct.length,
    });
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
  // section — including a genuine typo nobody has reviewed.
  if (isBrokenLink && (typeof target !== "string" || !target)) throw new Error("A broken-link rule must name the missing target");
  if (!isBrokenLink && target !== undefined) throw new Error("Only a broken-link rule may name a target");
  if (rule.action.type === "prefer_source") {
    // service.mjs 409s a prefer_source (choose_contribution) decision against
    // a broken_link discrepancy — there's no alternate source to prefer, only
    // the one dangling link — so a rule offering it would validate here and
    // then never be able to auto-apply.
    if (isBrokenLink) throw new Error("A broken link has no source to prefer — acknowledge it instead");
    if (typeof rule.action.source !== "string" || !sources.includes(rule.action.source)) throw new Error("Invalid preferred source");
  } else if (rule.action.type === "acknowledge") {
    if (!["different_scopes", "temporary_migration", "source_specific_authority", "target_missing", "other"].includes(rule.action.reasonCode)) {
      throw new Error("Invalid acknowledgement reason");
    }
  } else throw new Error("Invalid discrepancy rule action");
  if (rule.evidenceDecisionIds !== undefined
    && (!Array.isArray(rule.evidenceDecisionIds) || rule.evidenceDecisionIds.some((id) => typeof id !== "string"))) {
    throw new Error("Invalid discrepancy rule evidence");
  }
  return {
    id: rule.id, scope: rule.scope === "team" ? "team" : "local",
    mode: rule.mode, enabled: rule.enabled !== false,
    match: { kind, conceptType, key, sources: [...new Set(sources)].sort(), ...(isBrokenLink ? { target } : {}) },
    action: rule.action.type === "prefer_source"
      ? { type: "prefer_source", source: rule.action.source }
      : { type: "acknowledge", reasonCode: rule.action.reasonCode },
    evidenceDecisionIds: [...new Set(rule.evidenceDecisionIds ?? [])],
    ...(typeof rule.createdAt === "string" ? { createdAt: rule.createdAt } : {}),
    ...(typeof rule.updatedAt === "string" ? { updatedAt: rule.updatedAt } : {}),
  };
}
