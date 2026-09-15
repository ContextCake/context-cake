// The incremental BM25F index behind GET /api/search.
//
// searchConcepts (search.mjs) rebuilds its index from the whole corpus on
// every distinct query: re-concatenate every body, re-stem every term, one
// fresh frequency Map per field per document — seconds of CPU and hundreds of
// MB of allocation per debounced keystroke at vault scale, on the same event
// loop that serves /api/status. This module maintains the same index across
// queries and updates it by delta when content moves.
//
// BIT-IDENTICAL BY CONSTRUCTION, not by approximation:
//   - per-document analysis is search.mjs's own analyzeConceptFields;
//   - the corpus statistics (documentFrequency, per-field length totals,
//     document count) are INTEGER sums, maintained by add/subtract as
//     documents enter and leave — integer arithmetic is order-independent,
//     so the maintained values equal a fresh build's exactly;
//   - enumeration replicates collectDocuments order (layers in contributing
//     order, ids in snapshot order): the best-layer merge keeps the FIRST
//     layer's row on equal scores, so order is part of the ranking contract;
//   - scoring is search.mjs's scoreConceptSections, applied to the same
//     shapes: a concept's score is the max over its sections, same tie rule.
// search-index.test.mjs holds Object.is equality against searchConcepts
// under randomized mutation; the retrieval eval gates recall on top.
//
// MEMORY: analyzed fields are cached in a WeakMap keyed by the parsed concept
// OBJECT — the incremental snapshot carries unchanged concepts forward as the
// same object (service.mjs), so a one-note edit re-analyzes one note. The
// assembled index (per-doc frequency maps) is corpus-scale, so like the
// resolve-all memo it is evicted after an idle TTL: typing bursts reuse it,
// an idle engine drops it, and the WeakMap keeps re-assembly cheap because
// analysis survives on the concept objects themselves. Documents do NOT
// retain their body text — snippets are rebuilt from the winning concepts
// only, at hit time.

import { performance } from "node:perf_hooks";
import {
  FIXED_FIELD_COUNT, analyzeConceptFields, conceptBody, makeSnippet, scoreConceptSections, tokenizeQuery, analyze,
  linkPriorMultiplier,
} from "./search.mjs";
import { sectionText } from "./sections.mjs";
import { conceptLinkTargets } from "./markdown-links.mjs";
import { mergeConcepts, orderContributors } from "./resolver.mjs";

const IDLE_EVICT_MS = 30_000;
const LINKS_TO_CAP = 3;
const LINKS_TO_MAX = 5;

export function createSearchIndex({ idleEvictMs = IDLE_EVICT_MS } = {}) {
  // concept object -> analyzed fields. Survives index eviction on purpose:
  // it holds per-LIVE-SNAPSHOT work, and the snapshots own the lifetime.
  const analyzed = new WeakMap();
  // concept object -> that concept's own deduped, normalized, self-excluded
  // outgoing link targets (computed once per concept object, same lifetime
  // discipline as `analyzed`). Recomputed if the contributing layer names
  // change (a layer add/drop can change what a "layerName:path" prefix
  // resolves to) — see targetsFor.
  const linkTargets = new WeakMap();
  // layer name -> { gen, entries: Map<id, { id, concept, fields, sections, targets }> }
  // — entries in snapshot id order (Map preserves insertion).
  let layers = null;
  // { total, fixedTotals: number[FIXED_FIELD_COUNT], bodyTermTotal, sectionCount, documentFrequency }
  // fixedTotals is per-concept (id/title/description/tags), same discipline as
  // before. bodyTermTotal/sectionCount are corpus-wide sums across ALL
  // sections of ALL concepts — their ratio is the mean SECTION length, not a
  // per-concept average, because a 9-section runbook contributes 9 length
  // samples to the body average, not one.
  let stats = null;
  // target concept id -> Map<source concept id, refcount>. refcount is how
  // many currently-indexed layer entries of that source concept link to the
  // target — NOT how many links; a source in two layers linking to the same
  // target is one distinct source (inbound counts DISTINCT concepts), and a
  // source that stops linking (edit or removal) decrements rather than wipes.
  let linkRefs = null;
  let currentLayerNameSet = new Set();
  let evictTimer = null;
  // What the memory backend can report about its own last search() call —
  // the sqlite store's equivalent shape (search-store.mjs's lastSearchStats),
  // so diagnostics can read either backend the same optional-chained way.
  // decodedRecords stays null: this backend never decodes stored records —
  // everything is already parsed JS objects in the WeakMap/Map above.
  let lastStats = { candidateCount: null, syncMs: null, decodedRecords: null };

  // { fields: [id, title, description, tags], sections: [{key, heading, frequencies, length}] }
  function analysisFor(id, concept) {
    let analysis = analyzed.get(concept);
    if (!analysis) {
      analysis = analyzeConceptFields(id, concept);
      analyzed.set(concept, analysis);
    }
    return analysis;
  }

  function targetsFor(id, concept) {
    let cached = linkTargets.get(concept);
    if (!cached || cached.layerNameSet !== currentLayerNameSet) {
      const targets = conceptLinkTargets(conceptBody(concept), id, currentLayerNameSet)
        .filter((target) => target !== id);
      cached = { layerNameSet: currentLayerNameSet, targets };
      linkTargets.set(concept, cached);
    }
    return cached.targets;
  }

  function addLinkRefs(id, targets) {
    for (const target of targets) {
      let bySource = linkRefs.get(target);
      if (!bySource) {
        bySource = new Map();
        linkRefs.set(target, bySource);
      }
      bySource.set(id, (bySource.get(id) ?? 0) + 1);
    }
  }

  function removeLinkRefs(id, targets) {
    for (const target of targets) {
      const bySource = linkRefs.get(target);
      if (!bySource) continue;
      const next = (bySource.get(id) ?? 0) - 1;
      if (next <= 0) bySource.delete(id);
      else bySource.set(id, next);
      if (bySource.size === 0) linkRefs.delete(target);
    }
  }

  function inboundCount(id) {
    return linkRefs.get(id)?.size ?? 0;
  }

  // linksTo shows targets "that exist in the corpus" (the brief's words):
  // targetsFor only strips self-links (cheap, cacheable per concept object);
  // corpus membership can change on every query without that concept being
  // re-read, so it is checked here, at output time, against the layers this
  // update() just settled on.
  function corpusHas(id) {
    for (const entry of layers.values()) {
      if (entry.entries.has(id)) return true;
    }
    return false;
  }

  function addToStats({ fields, sections }) {
    stats.total += 1;
    const seen = new Set();
    for (let i = 0; i < fields.length; i += 1) {
      stats.fixedTotals[i] += fields[i].length;
      for (const term of fields[i].frequencies.keys()) seen.add(term);
    }
    for (const section of sections) {
      stats.bodyTermTotal += section.length;
      stats.sectionCount += 1;
      for (const term of section.frequencies.keys()) seen.add(term);
    }
    for (const term of seen) {
      stats.documentFrequency.set(term, (stats.documentFrequency.get(term) ?? 0) + 1);
    }
  }

  function removeFromStats({ fields, sections }) {
    stats.total -= 1;
    const seen = new Set();
    for (let i = 0; i < fields.length; i += 1) {
      stats.fixedTotals[i] -= fields[i].length;
      for (const term of fields[i].frequencies.keys()) seen.add(term);
    }
    for (const section of sections) {
      stats.bodyTermTotal -= section.length;
      stats.sectionCount -= 1;
      for (const term of section.frequencies.keys()) seen.add(term);
    }
    for (const term of seen) {
      const next = (stats.documentFrequency.get(term) ?? 0) - 1;
      if (next <= 0) stats.documentFrequency.delete(term);
      else stats.documentFrequency.set(term, next);
    }
  }

  function buildLayerEntries(view) {
    const entries = new Map();
    for (const id of view.ids) {
      const concept = view.concepts.get(id);
      if (!concept) continue; // collectDocuments skips unloadable concepts
      const { fields, sections } = analysisFor(id, concept);
      entries.set(id, { id, concept, fields, sections, targets: targetsFor(id, concept) });
    }
    return entries;
  }

  let layerNameKey = null;

  // Layer-prefixed links (`[[layerName:path]]`) resolve differently depending
  // on which layer names currently exist, so the target cache key changes
  // (a new Set object) only when the actual name SET changes — not on every
  // call, which would defeat the point of caching. A layer joining/leaving
  // therefore invalidates targetsFor for entries this update() rebuilds, but
  // an entry kept via the "gen unchanged" fast path below is not re-resolved
  // against the new set: an acceptable gap for a rare link form, traded for
  // not forcing a full re-walk on every layer add/drop.
  function syncLayerNames(contributing) {
    const key = contributing.map((view) => view.name).sort().join(",");
    if (key !== layerNameKey) {
      layerNameKey = key;
      currentLayerNameSet = new Set(contributing.map((view) => view.name));
    }
  }

  /**
   * Bring the index in line with the contributing snapshots.
   * `contributing`: [{ name, level, gen, ids, concepts }] in layer order.
   */
  function update(contributing) {
    syncLayerNames(contributing);
    if (!layers || !stats) {
      layers = new Map();
      stats = {
        total: 0,
        fixedTotals: Array.from({ length: FIXED_FIELD_COUNT }, () => 0),
        bodyTermTotal: 0,
        sectionCount: 0,
        documentFrequency: new Map(),
      };
      linkRefs = new Map();
      for (const view of contributing) {
        const entries = buildLayerEntries(view);
        for (const entry of entries.values()) {
          addToStats(entry);
          addLinkRefs(entry.id, entry.targets);
        }
        layers.set(view.name, { gen: view.gen, level: view.level, entries });
      }
      return;
    }
    const next = new Map();
    for (const view of contributing) {
      const previous = layers.get(view.name);
      if (previous && previous.gen === view.gen) {
        previous.level = view.level; // levels re-rank lanes, not scores
        next.set(view.name, previous);
        layers.delete(view.name);
        continue;
      }
      // Gen moved (or a new layer): rebuild this layer's entry list in the
      // new snapshot order. Unchanged concepts are the same OBJECT, so their
      // analysis — and their contribution to the stats — carries over
      // one-by-one instead of wholesale.
      const entries = buildLayerEntries(view);
      const old = previous?.entries ?? new Map();
      for (const [id, entry] of entries) {
        const before = old.get(id);
        if (before && before.concept === entry.concept) continue; // untouched
        if (before) {
          removeFromStats(before);
          removeLinkRefs(before.id, before.targets);
        }
        addToStats(entry);
        addLinkRefs(entry.id, entry.targets);
      }
      for (const [id, before] of old) {
        if (!entries.has(id)) {
          removeFromStats(before);
          removeLinkRefs(before.id, before.targets);
        }
      }
      if (previous) layers.delete(view.name);
      next.set(view.name, { gen: view.gen, level: view.level, entries });
    }
    // Layers that left the manifest: their documents leave the statistics.
    for (const [, gone] of layers) {
      for (const entry of gone.entries.values()) {
        removeFromStats(entry);
        removeLinkRefs(entry.id, entry.targets);
      }
    }
    layers = next;
  }

  function armEviction() {
    clearTimeout(evictTimer);
    evictTimer = setTimeout(() => {
      layers = null;
      stats = null; // the WeakMap keeps per-concept analysis; only the corpus-scale assembly drops
      linkRefs = null;
    }, idleEvictMs);
    evictTimer.unref?.();
  }

  return {
    /**
     * Same answer shape, order and scores as searchConcepts(views, ...) over
     * the same snapshots — see the header for why that equality holds.
     */
    search(contributing, { query, limit = 10, source, type }) {
      const rawTokens = tokenizeQuery(query);
      if (!query || typeof query !== "string" || rawTokens.length === 0) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      const syncStart = performance.now();
      update(contributing);
      const syncMs = performance.now() - syncStart;
      armEviction();
      const terms = [...new Set(analyze(query))];
      const index = {
        total: stats.total,
        averageLength: [
          ...stats.fixedTotals.map((sum) => (stats.total ? sum / stats.total : 0)),
          stats.sectionCount ? stats.bodyTermTotal / stats.sectionCount : 0,
        ],
        documentFrequency: stats.documentFrequency,
      };
      const levelByName = new Map(contributing.map((view) => [view.name, view.level]));
      const orderLayerNames = (names) =>
        [...new Set(names)].sort((a, b) => (levelByName.get(b) ?? 0) - (levelByName.get(a) ?? 0));

      const byId = new Map();
      // Filters select concepts, not scoring documents: keep the complete
      // corpus statistics and best-layer score, including a match in another
      // contribution to the selected source's concept. Switching a filter
      // must neither rebuild the index nor change a surviving hit's score.
      const sourceEntries = source ? layers.get(source)?.entries : null;
      if (source && !sourceEntries) return [];
      for (const view of contributing) {
        const layer = layers.get(view.name);
        if (!layer) continue;
        for (const entry of layer.entries.values()) {
          if (sourceEntries && !sourceEntries.has(entry.id)) continue;
          const best = scoreConceptSections(index, entry, terms);
          if (best.score <= 0) continue;
          const winningSection = best.matched ? entry.sections[best.sectionIndex] : null;
          const section = winningSection ? { key: winningSection.key, heading: winningSection.heading } : null;
          // Deferred: bodies are not retained by the index, and only hits
          // need one. Resolved to text after the cut below — sectionOf wins
          // over snippetOf (the whole concept) when a section actually
          // matched, falling back to the whole body otherwise.
          const sectionOf = best.matched ? entry.concept.sections[best.sectionIndex] : null;
          const existing = byId.get(entry.id);
          if (!existing) {
            byId.set(entry.id, {
              id: entry.id,
              title: entry.concept.frontmatter.title ?? null,
              score: best.score,
              layers: [view.name],
              section,
              snippetOf: entry.concept,
              sectionOf,
              targetsOf: entry.targets,
            });
          } else {
            if (best.score > existing.score) {
              existing.score = best.score;
              existing.section = section;
              existing.snippetOf = entry.concept;
              existing.sectionOf = sectionOf;
              existing.targetsOf = entry.targets;
            }
            existing.layers.push(view.name);
            if (!existing.title) existing.title = entry.concept.frontmatter.title ?? null;
          }
        }
      }

      // The prior is per CONCEPT, not per layer contribution — applied once
      // here, after the best-layer merge, before the type filter and sort.
      for (const hit of byId.values()) {
        hit.inbound = inboundCount(hit.id);
        hit.score *= linkPriorMultiplier(hit.inbound);
      }

      // byId at this point is the full candidate set (score > 0, before the
      // type filter/sort/top-k slice) — the same thing search-store.mjs's
      // lastSearchStats().candidateCount means for the sqlite backend.
      lastStats = { candidateCount: byId.size, syncMs, decodedRecords: null };

      return [...byId.values()]
        .filter((hit) => {
          if (!type) return true;
          // Use the resolver's frontmatter semantics, including equal-level
          // date ties, inherited types, and full overrides. Section bodies
          // aren't needed to compute this facet.
          const contributors = contributing.flatMap((view) => {
            const concept = layers.get(view.name)?.entries.get(hit.id)?.concept;
            return concept ? [{ layer: view.name, level: view.level, updated: concept.frontmatter.updated ?? null, frontmatter: concept.frontmatter, sections: [] }] : [];
          });
          return (mergeConcepts(orderContributors(contributors)).frontmatter.type ?? "concept") === type;
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Number(limit) || 10)
        .map(({ snippetOf, sectionOf, targetsOf, ...hit }, rank) => {
          const result = {
            ...hit,
            snippet: makeSnippet(sectionOf ? sectionText(sectionOf) : conceptBody(snippetOf), rawTokens),
            layers: orderLayerNames(hit.layers),
          };
          if (rank < LINKS_TO_CAP) result.linksTo = targetsOf.filter(corpusHas).slice(0, LINKS_TO_MAX);
          return result;
        });
    },
    // The memory-backend counterpart of search-store.mjs's lastSearchStats():
    // what THIS instance's last search() call did, for diagnostics to read
    // the same optional-chained way regardless of which backend answered.
    lastSearchStats() {
      return lastStats;
    },
    close() {
      clearTimeout(evictTimer);
      layers = null;
      stats = null;
      linkRefs = null;
    },
  };
}
