// Structural discrepancy projection over resolved concepts. This module never
// changes resolver precedence and never performs semantic/model inference.
//
// Everything here is pure: buildDiscrepancies projects a resolved corpus plus
// this profile's decisions/rules/priorities into records; summarize/compact/
// filter reshape a projection for the wire; the link index proposes
// structural candidates for a broken link's target (case, extension, slug,
// basename, title, bounded edit distance — never a model); rewriteLinkTarget
// and removeLink edit link syntax in section text without touching anything
// else. The service memoizes the projection and the control operations act on
// it; neither re-derives any of this.

import { createHash } from "node:crypto";
import { posix } from "node:path";

export const DISCREPANCY_KINDS = new Set([
  "section_content", "frontmatter_value", "broken_link", "changed_after_decision",
]);

// The statuses a person (or an automatic rule) still has something to do
// about. Mirrored by the console's discrepancy-summary helper — the two lists
// must agree or the header count and the list disagree.
export const ACTIONABLE_STATUSES = new Set(["needs_review", "reopened", "recommended", "auto_ready", "blocked"]);
export const DISCREPANCY_STATUSES = ["needs_review", "reopened", "recommended", "auto_ready", "acknowledged", "resolved", "blocked"];

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
  // Built on the first broken link, once per projection: a corpus with no
  // dangling links never pays for the index, and one with 400 links to nine
  // targets pays for the candidate search nine times (see candidatesFor).
  let linkIndex = null;
  const candidateMemo = new Map();

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
          linkIndex ??= buildLinkIndex(concepts);
          const candidates = candidatesFor(target, { linkingConceptId: concept.id, linkingConceptType: conceptType }, linkIndex, candidateMemo);
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
            // Structural repair proposals. Deliberately NOT part of `revision`
            // (finalize fingerprints contributions only): a new concept
            // appearing elsewhere changes what we would suggest, not what the
            // link says, and a decision taken against the link must not go
            // stale because a suggestion improved.
            candidates, bestCandidate: bestCandidateOf(candidates),
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
      // A resolved broken link keeps naming its target so it groups and filters
      // beside the open ones; a rewrite's effective value is where it points now.
      ...(typeof latest.linkTarget === "string" ? { target: latest.linkTarget } : {}),
      owner: latest.owner ?? "Unassigned", effectiveSource: latest.chosen?.layer ?? null,
      effectiveValue: latest.chosen?.content ?? latest.reconciledContent ?? latest.newTarget ?? null,
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

// `conceptType` and `key` may be the literal wildcard "*" (a broken-link rule
// generalized from evidence spanning several sections — see
// suggestDiscrepancyRules; validateRule refuses the wildcard for any other
// kind); `kind`, `sources`, and a broken link's `target` are always exact. A
// wildcard rule and an exact rule that disagree both match, and two matching
// rules with different actions are a `conflict` — automation is disabled, no
// specificity order is invented.
const matchesField = (ruleValue, value) => ruleValue === "*" || ruleValue === value;

function matchRules(item, rules) {
  const sources = item.contributions.map((c) => c.source).sort().join("|");
  const matches = rules.filter((rule) => rule.enabled !== false
    && rule.match?.kind === item.kind
    && matchesField(rule.match?.conceptType, item.conceptType)
    && matchesField(rule.match?.key, item.key)
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

// ---- link syntax ---------------------------------------------------------------
//
// extractLinks decides what counts as an outgoing local link; rewriteLinkTarget
// and removeLink walk exactly the same two patterns, so a link this projection
// reports as broken is a link those helpers can reach, and nothing else in the
// text is ever touched.

const MARKDOWN_LINK = /!?\[[^\]]*]\(([^)]+)\)/g;
const WIKI_LINK = /\[\[([^\]|]+)(?:\|[^\]]+)?]]/g;

export function extractLinks(text) {
  const out = [];
  for (const match of String(text).matchAll(MARKDOWN_LINK)) {
    if (!match[0].startsWith("!") && localTarget(match[1])) out.push(cleanTarget(match[1]));
  }
  for (const match of String(text).matchAll(WIKI_LINK)) {
    if (localTarget(match[1])) out.push(cleanTarget(match[1]));
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Point every link to `oldTarget` at `newTarget`, preserving everything the
 * author wrote around the id: a `./` prefix, a `.md` extension, a `#anchor`,
 * surrounding whitespace, and a wikilink's `|alias`. Images are never links
 * here (extractLinks skips them), so they are never rewritten either.
 */
export function rewriteLinkTarget(text, oldTarget, newTarget) {
  let replaced = 0;
  const swap = (raw) => {
    if (!localTarget(raw) || cleanTarget(raw) !== oldTarget) return raw;
    replaced += 1;
    // Undo cleanTarget's steps in order so the reassembly is exact: split at
    // the first '#', strip a leading './', strip a trailing '.md', trim.
    const hash = raw.indexOf("#");
    const before = hash === -1 ? raw : raw.slice(0, hash);
    const anchor = hash === -1 ? "" : raw.slice(hash);
    let core = before;
    const dot = core.startsWith("./") ? "./" : "";
    core = core.slice(dot.length);
    const ext = /\.md$/i.test(core) ? core.slice(-3) : "";
    core = core.slice(0, core.length - ext.length);
    const lead = core.match(/^\s*/)[0];
    const trail = core.match(/\s*$/)[0];
    return `${dot}${lead}${newTarget}${trail}${ext}${anchor}`;
  };
  let out = String(text).replace(MARKDOWN_LINK, (whole, raw) => {
    if (whole.startsWith("!")) return whole;
    const next = swap(raw);
    return next === raw ? whole : whole.slice(0, whole.length - raw.length - 1) + next + ")";
  });
  out = out.replace(WIKI_LINK, (whole, raw) => {
    const next = swap(raw);
    return next === raw ? whole : `[[${next}${whole.slice(2 + raw.length)}`;
  });
  return { text: out, replaced };
}

/**
 * Turn every link to `target` back into plain text: `[label](t)` → `label`,
 * `[[t|alias]]` → `alias`, `[[t]]` → the target's basename. Images untouched.
 */
export function removeLink(text, target) {
  let replaced = 0;
  const hit = (raw) => localTarget(raw) && cleanTarget(raw) === target;
  let out = String(text).replace(MARKDOWN_LINK, (whole, raw) => {
    if (whole.startsWith("!") || !hit(raw)) return whole;
    replaced += 1;
    return whole.slice(1, whole.indexOf("]("));
  });
  out = out.replace(WIKI_LINK, (whole, raw) => {
    if (!hit(raw)) return whole;
    replaced += 1;
    const pipe = whole.indexOf("|");
    return pipe === -1 ? posix.basename(cleanTarget(raw)) : whole.slice(pipe + 1, -2);
  });
  return { text: out, replaced };
}

function localTarget(target) { return !/^[a-z][a-z0-9+.-]*:/i.test(String(target)) && !String(target).startsWith("#"); }
function cleanTarget(target) { return String(target).split("#")[0].replace(/^\.\//, "").replace(/\.md$/i, "").trim(); }

// ---- broken-link candidates ---------------------------------------------------
//
// A broken link's target is a string that used to name a concept, or nearly
// does. The rules below are lexical and structural only — a renamed folder, a
// case or extension slip, a slugified title, a one-letter typo — ranked by how
// mechanical the explanation is. Nothing here reads content or infers meaning.

const STRIPPABLE_EXT = /\.(mdx|markdown|txt|html)$/i;
const CANDIDATE_LIMIT = 5;
const BEST_MIN_CONFIDENCE = 0.85;
const BEST_MIN_GAP = 0.15;
const TYPO_SCAN_LIMIT = 1000;

function normalizeSlug(value) {
  return String(value).toLowerCase().replace(STRIPPABLE_EXT, "").replace(/\.md$/, "")
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

function pushMulti(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * Every lookup table candidatesFor needs, built once per projection. Ids are
 * inserted in sorted order so every multi-valued bucket is deterministic.
 */
export function buildLinkIndex(concepts) {
  const sorted = [...concepts].sort((a, b) => a.id.localeCompare(b.id));
  const index = {
    ids: new Set(), lowerById: new Map(), byBasename: new Map(), byNormalizedId: new Map(),
    byNormalizedBasename: new Map(), byTitleSlug: new Map(), basenamesByLength: new Map(), typeById: new Map(),
  };
  for (const concept of sorted) {
    const id = concept.id;
    if (index.ids.has(id)) continue;
    index.ids.add(id);
    const lower = id.toLowerCase();
    if (!index.lowerById.has(lower)) index.lowerById.set(lower, id);
    const base = posix.basename(id);
    pushMulti(index.byBasename, base, id);
    pushMulti(index.byNormalizedId, normalizeSlug(id), id);
    pushMulti(index.byNormalizedBasename, normalizeSlug(base), id);
    const title = concept.frontmatter?.title;
    if (typeof title === "string" && title.trim()) pushMulti(index.byTitleSlug, normalizeSlug(title.trim()), id);
    const type = String(concept.frontmatter?.type ?? "concept");
    index.typeById.set(id, type);
    pushMulti(index.basenamesByLength, base.length, {
      id, base: base.toLowerCase(), first: base.charAt(0).toLowerCase(), dir: posix.dirname(id), type,
    });
  }
  return index;
}

/**
 * ≤5 `{ id, reason, confidence }` for a dangling `target`, best first, ties by
 * id. Memoized per (target, linking folder, linking type) — the only inputs
 * the rules read besides the index — so 400 links to one renamed concept cost
 * one search. Confidence is a rank, not a probability: it orders the reasons
 * and gates bestCandidate; it is not calibrated against anything.
 */
export function candidatesFor(target, { linkingConceptId = "", linkingConceptType = "concept" } = {}, index, memo = null) {
  const dir = posix.dirname(String(linkingConceptId));
  const memoKey = `${target}\u0000${dir}\u0000${linkingConceptType}`;
  if (memo?.has(memoKey)) return memo.get(memoKey);
  const found = new Map(); // id -> { id, reason, confidence }
  // Rules run in priority order and the first one to name an id keeps it: an
  // exact-basename match stays "moved" even when a later, fuzzier rule would
  // score the same id higher, so the reason shown is the most mechanical one.
  const offer = (id, reason, confidence) => {
    if (!id || id === target || !index.ids.has(id) || found.has(id)) return;
    found.set(id, { id, reason, confidence });
  };
  const offerBucket = (list, reason, unique, several) => {
    if (!list?.length) return;
    for (const id of list) offer(id, reason, list.length === 1 ? unique : several);
  };

  const relative = posix.normalize(posix.join(dir, target));
  offer(relative, "relative", 0.95);
  offer(index.lowerById.get(target.toLowerCase()), "case", 0.95);
  if (STRIPPABLE_EXT.test(target)) offer(target.replace(STRIPPABLE_EXT, ""), "extension", 0.95);
  offerBucket(index.byNormalizedId.get(normalizeSlug(target)), "slug", 0.90, 0.90);
  const base = posix.basename(target);
  offerBucket(index.byBasename.get(base), "moved", 0.85, 0.60);
  offerBucket(index.byTitleSlug.get(normalizeSlug(target)), "title", 0.85, 0.60);
  offerBucket(index.byNormalizedBasename.get(normalizeSlug(base)), "slug_moved", 0.70, 0.70);

  // Edit distance is the expensive rule and the least certain one, so it runs
  // only when every structural rule came up empty, over length buckets ±2 with
  // a cheap prefilter (same first letter or same folder). Bounded three ways:
  // the band (≤2 edits, ≤1 for short names where two edits is a different
  // word), a character-histogram reject before any matrix work, and a hard
  // cap on entries examined per target. The entries are examined longest
  // shared prefix first (same folder ahead within a tie), so the cap drops the
  // least similar names — a 20k-note daily-notes vault whose basenames all
  // share a shape cannot turn one dangling link into a 10k-pair scan, and
  // the sibling a typo most likely meant is still the first thing compared.
  if (found.size === 0 && base) {
    const lowerBase = base.toLowerCase();
    const maxEdits = base.length < 6 ? 1 : 2;
    const first = lowerBase.charAt(0);
    const byPrefix = Array.from({ length: lowerBase.length + 1 }, () => [[], []]); // [same folder, other]
    for (let len = Math.max(1, base.length - maxEdits); len <= base.length + maxEdits; len += 1) {
      for (const entry of index.basenamesByLength.get(len) ?? []) {
        const sameDir = entry.dir === dir;
        if (!sameDir && entry.first !== first) continue;
        byPrefix[commonPrefix(lowerBase, entry.base)][sameDir ? 0 : 1].push(entry);
      }
    }
    let examined = 0;
    scan: for (let prefix = lowerBase.length; prefix >= 0; prefix -= 1) {
      for (const bucket of byPrefix[prefix]) {
        for (const entry of bucket) {
          if (++examined > TYPO_SCAN_LIMIT) break scan;
          if (histogramDistance(lowerBase, entry.base) > 2 * maxEdits) continue;
          const distance = damerauLevenshtein(lowerBase, entry.base, maxEdits);
          if (distance === null || distance === 0) continue;
          const confidence = (distance === 1 ? 0.60 : 0.50) + (entry.type === linkingConceptType ? 0.05 : 0);
          offer(entry.id, "typo", confidence);
        }
      }
    }
  }

  const ranked = [...found.values()]
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, CANDIDATE_LIMIT);
  memo?.set(memoKey, ranked);
  return ranked;
}

/** The top candidate when it clearly stands out; null when the answer is a guess. */
export function bestCandidateOf(candidates) {
  const [top, next] = candidates ?? [];
  if (!top || top.confidence < BEST_MIN_CONFIDENCE) return null;
  if (next && top.confidence - next.confidence < BEST_MIN_GAP) return null;
  return top;
}

function commonPrefix(a, b) {
  const limit = a.length < b.length ? a.length : b.length;
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

// L1 distance between the two strings' character histograms. One edit moves
// this by at most 2 (a substitution), so a pair further apart than 2·max
// cannot be within `max` edits — and it costs a pass over each string, no
// matrix. Scratch counts are reset by walking the same strings back.
const histogram = new Int32Array(0x10000);
function histogramDistance(a, b) {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const c = a.charCodeAt(i);
    distance += histogram[c] >= 0 ? 1 : -1;
    histogram[c] += 1;
  }
  for (let i = 0; i < b.length; i += 1) {
    const c = b.charCodeAt(i);
    distance += histogram[c] > 0 ? -1 : 1;
    histogram[c] -= 1;
  }
  for (let i = 0; i < a.length; i += 1) histogram[a.charCodeAt(i)] = 0;
  for (let i = 0; i < b.length; i += 1) histogram[b.charCodeAt(i)] = 0;
  return distance;
}

// Optimal string alignment distance (adjacent transposition counts as one
// edit), banded to ±max around the diagonal and cut off the moment a row's
// minimum passes `max` — returns null past the band. Three reused scratch
// rows, no per-call allocation: a daily-notes vault where every basename is
// `2026-08-18`-shaped puts thousands of same-length, same-first-char names in
// one bucket, and this runs once per (bucket entry × dangling target).
const OSA_INF = 1e9;
const osaRows = [[], [], []];
function damerauLevenshtein(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return null;
  let prev2 = null;
  let prev = osaRows[0];
  let cur = osaRows[1];
  let spare = osaRows[2];
  for (let j = 0; j <= m; j += 1) prev[j] = j <= max ? j : OSA_INF;
  for (let i = 1; i <= n; i += 1) {
    const lo = i - max > 1 ? i - max : 1;
    const hi = i + max < m ? i + max : m;
    cur[0] = i;
    if (lo > 1) cur[lo - 1] = OSA_INF;
    let rowMin = OSA_INF;
    const ai = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j += 1) {
      const bj = b.charCodeAt(j - 1);
      let value = prev[j] + 1;
      const insert = cur[j - 1] + 1;
      if (insert < value) value = insert;
      const substitute = prev[j - 1] + (ai === bj ? 0 : 1);
      if (substitute < value) value = substitute;
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        const swap = prev2[j - 2] + 1;
        if (swap < value) value = swap;
      }
      cur[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (hi < m) cur[hi + 1] = OSA_INF;
    if (rowMin > max) return null;
    const recycled = prev2 ?? spare;
    prev2 = prev;
    prev = cur;
    cur = recycled;
  }
  return prev[m] > max ? null : prev[m];
}

// ---- wire shapes ------------------------------------------------------------------

/**
 * Counts and groupings over a projection, so a client can say "412 broken
 * links to 9 targets, 380 auto-fixable" without holding the list. Every group
 * carries `count` (all records) and `actionable`; `topTargets` also carries the
 * shared bestCandidate when every record for that target agrees on one.
 */
export function summarizeDiscrepancies(list, { topN = 25 } = {}) {
  const byKind = Object.fromEntries([...DISCREPANCY_KINDS].map((kind) => [kind, 0]));
  const byStatus = Object.fromEntries(DISCREPANCY_STATUSES.map((status) => [status, 0]));
  const sourcePairs = new Map();
  const owners = new Map();
  const conceptTypes = new Map();
  const targets = new Map();
  const concepts = new Map();
  let actionable = 0;
  const bump = (map, key, item, extra = null) => {
    const row = map.get(key) ?? { count: 0, actionable: 0, ...(extra ?? {}) };
    row.count += 1;
    if (ACTIONABLE_STATUSES.has(item.status)) row.actionable += 1;
    map.set(key, row);
    return row;
  };
  const quickWins = { autoReady: 0, recommended: 0, brokenLinksWithBestCandidate: 0, brokenLinksTotal: 0 };
  for (const item of list) {
    const isActionable = ACTIONABLE_STATUSES.has(item.status);
    if (isActionable) actionable += 1;
    if (item.kind in byKind) byKind[item.kind] += 1; else byKind[item.kind] = 1;
    if (item.status in byStatus) byStatus[item.status] += 1; else byStatus[item.status] = 1;
    const sources = (item.contributions ?? []).map((entry) => entry.source).sort();
    bump(sourcePairs, sources.join("|"), item, { sources });
    bump(owners, String(item.owner ?? "Unassigned"), item, { owner: String(item.owner ?? "Unassigned") });
    bump(conceptTypes, String(item.conceptType ?? "concept"), item, { conceptType: String(item.conceptType ?? "concept") });
    bump(concepts, item.conceptId, item, { conceptId: item.conceptId, conceptTitle: item.conceptTitle ?? item.conceptId });
    if ((item.originalKind ?? item.kind) === "broken_link" && typeof item.target === "string") {
      const row = bump(targets, item.target, item, { target: item.target, bestCandidate: null, agree: true });
      // The shared candidate is agreed over the ACTIONABLE rows only: a
      // resolved row (the audit trail of a link already fixed) carries none,
      // and must not veto the "rewrite the rest → X" default for the group.
      if (isActionable) {
        if (row.actionable === 1) row.bestCandidate = item.bestCandidate ?? null;
        else if ((row.bestCandidate?.id ?? null) !== (item.bestCandidate?.id ?? null)) row.agree = false;
        quickWins.brokenLinksTotal += 1;
        if (item.bestCandidate) quickWins.brokenLinksWithBestCandidate += 1;
      }
    }
    if (item.status === "auto_ready") quickWins.autoReady += 1;
    if (item.status === "recommended") quickWins.recommended += 1;
  }
  const top = (map, keyField) => [...map.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || b.actionable - a.actionable || String(ka).localeCompare(String(kb)))
    .slice(0, topN)
    .map(([key, row]) => ({ key, ...row, ...(keyField ? { [keyField]: row[keyField] } : {}) }));
  return {
    total: list.length,
    actionable,
    byKind,
    byStatus,
    bySourcePair: top(sourcePairs).map(({ key, sources, count, actionable: a }) => ({ key, sources, count, actionable: a })),
    byOwner: top(owners).map(({ owner, count, actionable: a }) => ({ owner, count, actionable: a })),
    byConceptType: top(conceptTypes).map(({ conceptType, count, actionable: a }) => ({ conceptType, count, actionable: a })),
    topTargets: top(targets).map(({ target, count, actionable: a, bestCandidate, agree }) => ({ target, count, actionable: a, bestCandidate: agree ? bestCandidate : null })),
    topConcepts: top(concepts).map(({ conceptId, conceptTitle, count, actionable: a }) => ({ conceptId, conceptTitle, count, actionable: a })),
    quickWins,
  };
}

/**
 * The list-row shape: bodies become previews, history becomes a count plus
 * the latest decision. Everything a client needs to render a row, select it,
 * group it, or decide it (id, revision, kind, status, candidates) is intact;
 * `?id=` fetches the full record on demand.
 */
export function compactDiscrepancy(record, { previewChars = 240 } = {}) {
  const preview = (value) => {
    const kind = Array.isArray(value) ? "list" : value && typeof value === "object" ? "map" : "string";
    const text = kind === "string" ? String(value ?? "") : JSON.stringify(value);
    const truncated = text.length > previewChars;
    return {
      value: truncated ? `${text.slice(0, Math.max(0, previewChars - 1))}…` : text,
      truncated, valueBytes: Buffer.byteLength(text, "utf8"), valueKind: kind,
    };
  };
  const { history, effectiveValue, contributions, ...rest } = record;
  const latest = history?.at(-1) ?? null;
  return {
    ...rest,
    effectiveValue: effectiveValue == null ? effectiveValue : preview(effectiveValue).value,
    contributions: (contributions ?? []).map((item) => ({ ...item, ...preview(item.value) })),
    historyCount: history?.length ?? 0,
    latestDecision: latest ? {
      id: latest.id, action: latest.action ?? null, decidedAt: latest.decidedAt ?? null,
      transactionState: latest.transactionState ?? null,
      ...(latest.reasonCode ? { reasonCode: latest.reasonCode } : {}),
    } : null,
    compact: true,
  };
}

/** Narrow a projection. `status: "actionable"` means ACTIONABLE_STATUSES; every other field is an exact match. */
export function filterDiscrepancies(list, { status, kind, conceptId, target, source, owner, conceptType } = {}) {
  return list.filter((item) => {
    if (status && status !== "all") {
      if (status === "actionable" ? !ACTIONABLE_STATUSES.has(item.status) : item.status !== status) return false;
    }
    if (kind && item.kind !== kind) return false;
    if (conceptId && item.conceptId !== conceptId) return false;
    if (target && item.target !== target) return false;
    if (owner && String(item.owner ?? "Unassigned") !== owner) return false;
    if (conceptType && String(item.conceptType ?? "concept") !== conceptType) return false;
    if (source && !(item.contributions ?? []).some((entry) => entry.source === source)) return false;
    return true;
  });
}
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
