// Concept read helpers shared by the MCP server, the HTTP service, and the
// `contextcake concept` CLI family. Each adapter used to carry its own copy;
// they live here so `concept list`/`concept links` answer exactly what
// `list_concepts`/`get_links` answer, and `concept read` decorates a resolved
// concept exactly as `/api/resolve` does (control-plane spec §5.7).
//
// Nothing here ranks or merges: resolution stays in resolver.mjs and ranking
// in search.mjs. `layers` is always an already-selected profile's adapters.

import fsp from "node:fs/promises";
import path from "node:path";
import { isNewerDay } from "./conflict-policy.mjs";
import { fingerprint } from "./discrepancies.mjs";
import { parseRuleDocument } from "./discrepancy-rules.mjs";
import { extractLinks, normalizeId, resolveLinkTarget } from "./markdown-links.mjs";
import { resolveConcept } from "./resolver.mjs";
import { sectionText } from "./sections.mjs";

// Highest level first; a name that is not a layer sorts as level 0.
export function orderLayerNames(layers, names) {
  const levels = new Map(layers.map((layer) => [layer.name, layer.level]));
  const unique = [...new Set(names)];
  return unique.sort((a, b) => (levels.get(b) ?? 0) - (levels.get(a) ?? 0));
}

export async function layersWith(layers, id) {
  const results = await Promise.all(layers.map(async (source) => {
    const entry = await source.loadConcept(id);
    return entry ? source.name : null;
  }));
  return results.filter(Boolean);
}

// The `list_concepts` answer: every concept id with its contributing layers.
// A type filter compares the EFFECTIVE (resolved) type.
export async function listConcepts(layers, { type } = {}) {
  const byId = new Map();
  for (const source of layers) {
    for (const id of await source.listConceptIds()) {
      const entry = await source.loadConcept(id);
      const frontmatter = entry?.frontmatter ?? {};
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, type: frontmatter.type ?? null, title: frontmatter.title ?? null, layers: [source.name] });
      } else {
        existing.layers.push(source.name);
      }
    }
  }

  const entries = [...byId.values()].map((entry) => ({ ...entry, layers: orderLayerNames(layers, entry.layers) }));
  if (!type) return entries.sort((a, b) => a.id.localeCompare(b.id));

  const resolvedAll = await Promise.all(entries.map((e) => resolveConcept(e.id, layers)));
  return entries
    .filter((_, i) => resolvedAll[i]?.frontmatter.type === type)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeIncoming(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.id}@${row.layer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * The `get_links` answer. Outgoing links come from the effective section
 * content (after any recorded context resolution the caller's `resolve`
 * applies); incoming links are original source references per layer.
 *
 * resolve(id) -> resolved concept or null. Defaults to a plain resolve.
 */
export async function getLinks(layers, conceptId, { resolve = (id) => resolveConcept(id, layers) } = {}) {
  const id = normalizeId(conceptId);
  const layerNameSet = new Set(layers.map((layer) => layer.name));
  const resolved = await resolve(id);
  if (!resolved) throw new Error(`Concept not found in any layer: ${id}`);

  const body = resolved.sections.map((s) => `${s.heading ?? ""}\n${s.content}`).join("\n");
  const rawLinks = extractLinks(body, layerNameSet).map((link) => {
    const targetId = resolveLinkTarget(id, link.target, layerNameSet);
    return { raw: link.raw, target: link.target, id: targetId };
  });
  const outgoing = await Promise.all(rawLinks.map(async (link) => ({
    ...link,
    layers: link.id ? orderLayerNames(layers, await layersWith(layers, link.id)) : [],
  })));

  const incoming = [];
  for (const source of layers) {
    for (const sourceId of await source.listConceptIds()) {
      if (sourceId === id) continue;
      const entry = await source.loadConcept(sourceId);
      if (!entry) continue;
      const sourceBody = entry.sections.map((s) => `${s.heading ?? ""}\n${sectionText(s)}`).join("\n");
      for (const link of extractLinks(sourceBody, layerNameSet)) {
        if (resolveLinkTarget(sourceId, link.target, layerNameSet) === id) {
          incoming.push({ id: sourceId, layer: source.name, raw: link.raw });
          break;
        }
      }
    }
  }

  return {
    source: { id, contributors: resolved.contributors },
    outgoing,
    incoming: dedupeIncoming(incoming).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Local rules win over a team rule with the same id; the team file lives in
// the live layer root. Same merge control/discrepancies.mjs effectiveRules does.
export async function effectiveDiscrepancyRules(ruleStore, liveLayerRoot = null) {
  const localRules = await ruleStore.list();
  let teamRules = [];
  if (liveLayerRoot) {
    try { teamRules = parseRuleDocument(await fsp.readFile(path.join(liveLayerRoot, ".contextcake/discrepancy-rules.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const localById = new Map(localRules.map((rule) => [rule.id, rule]));
  return [...teamRules.map((rule) => localById.get(rule.id) ?? rule),
    ...localRules.filter((rule) => !teamRules.some((team) => team.id === rule.id))];
}

// The discrepancy status /api/resolve and MCP read_file attach to each
// contested section, from the latest recorded decision for it. Fingerprints use
// discrepancies.mjs fingerprint(), the form control/discrepancies.mjs records.
// (The legacy conflict-resolution route records raw hashes, but only on
// choose_contribution records, which read "reopened" either way.)
export function decorateResolvedDispositions(resolved, decisions) {
  for (const section of resolved.sections) {
    if (!section.conflicts?.length) continue;
    const id = `section_content::${resolved.id}::${section.key}`;
    const latest = decisions.filter((row) => row.discrepancyId === id || row.conflictId === `${resolved.id}::${section.key}`).at(-1);
    const current = [
      { source: section.sourceLayer, fingerprint: fingerprint(section.content) },
      ...section.conflicts.map((item) => ({ source: item.layer, fingerprint: fingerprint(item.content) })),
    ].map((item) => `${item.source}:${item.fingerprint}`).sort();
    const recorded = (latest?.contributorFingerprints ?? []).map((item) => `${item.source}:${item.fingerprint}`).sort();
    const unchanged = recorded.length === current.length && recorded.every((value, index) => value === current[index]);
    section.discrepancy = {
      id,
      status: latest?.action === "acknowledge" && unchanged ? "acknowledged" : latest ? "reopened" : "needs_review",
      ...(latest?.id ? { decisionId: latest.id } : {}),
      ...(latest?.reasonCode ? { reasonCode: latest.reasonCode } : {}),
    };
  }
}

// The markdown `read_file` returns: frontmatter, sections, and every dissent
// quoted under the section it disagrees with.
export function assembleMarkdown(resolved, { retentionDays = 14 } = {}) {
  const fmLines = Object.entries(resolved.frontmatter).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  const banner = resolved.frontmatter.status === "unreviewed"
    ? `> ⚠ unreviewed capture from ${resolved.frontmatter.author ?? "unknown"}, ${resolved.frontmatter.captured ?? "?"} — decays after ${retentionDays} days unless promoted\n\n`
    : "";
  const front = `---\n${fmLines.join("\n")}\n---\n\n${banner}`;
  const bodyParts = resolved.sections.map((s) => {
    // A suppressed section is an explicit tombstone. Rendering nothing would
    // hide that a layer deliberately withdrew it — say who suppressed it.
    if (s.suppressed) {
      const note = `_(suppressed by ${s.sourceLayer})_`;
      return s.heading ? `${s.heading}\n\n${note}` : note;
    }
    const resolutionNote = s.contextResolution
      ? `\n\n> ContextCake resolution ${s.contextResolution.status}: policy ${s.contextResolution.policyId}; selected source ${s.contextResolution.selectedSource}. Original source documents are preserved.` : "";
    const head = (s.heading ? `${s.heading}\n\n${s.content}` : s.content) + resolutionNote;
    if (!s.conflicts || s.conflicts.length === 0) return head;
    const notes = s.conflicts.map((c) => renderDissent(c, s.sourceUpdated)).join("\n\n");
    return `${head}\n\n${notes}`;
  });
  return front + bodyParts.join("\n\n");
}

// One blockquote per dissent: a header line naming the layer and date — marked
// when the dissent is newer than the effective value (day granularity, both
// dates must parse; see conflict-policy.mjs) — then the dissent's full content
// with every line quoted. An empty-content dissent is a lower layer's tombstone
// for a section a higher layer kept. Undated dissent renders `(updated ?)`.
export function renderDissent(dissent, sourceUpdated) {
  const updated = dissent.updated ?? "?";
  if (!dissent.content) return `> ⚠ ${dissent.layer} suppresses this section (updated ${updated})`;
  const newer = isNewerDay(dissent.updated, sourceUpdated) ? " — ⚠ newer than the effective value" : "";
  const body = dissent.content.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  return `> ⚠ ${dissent.layer} disagrees (updated ${updated})${newer}:\n${body}`;
}
