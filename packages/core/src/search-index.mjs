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
//   - scoring is search.mjs's scoreEntry, applied to the same shapes.
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

import {
  FIELD_COUNT, analyzeConceptFields, conceptBody, makeSnippet, scoreEntry, tokenizeQuery, analyze,
} from "./search.mjs";

const IDLE_EVICT_MS = 30_000;

export function createSearchIndex({ idleEvictMs = IDLE_EVICT_MS } = {}) {
  // concept object -> analyzed fields. Survives index eviction on purpose:
  // it holds per-LIVE-SNAPSHOT work, and the snapshots own the lifetime.
  const analyzed = new WeakMap();
  // layer name -> { gen, entries: Map<id, { id, concept, fields }> } —
  // entries in snapshot id order (Map preserves insertion).
  let layers = null;
  let stats = null; // { total, fieldTotals: number[], documentFrequency: Map }
  let evictTimer = null;

  function fieldsFor(id, concept) {
    let fields = analyzed.get(concept);
    if (!fields) {
      fields = analyzeConceptFields(id, concept);
      analyzed.set(concept, fields);
    }
    return fields;
  }

  function addToStats(fields) {
    stats.total += 1;
    const seen = new Set();
    for (let i = 0; i < fields.length; i += 1) {
      stats.fieldTotals[i] += fields[i].length;
      for (const term of fields[i].frequencies.keys()) seen.add(term);
    }
    for (const term of seen) {
      stats.documentFrequency.set(term, (stats.documentFrequency.get(term) ?? 0) + 1);
    }
  }

  function removeFromStats(fields) {
    stats.total -= 1;
    const seen = new Set();
    for (let i = 0; i < fields.length; i += 1) {
      stats.fieldTotals[i] -= fields[i].length;
      for (const term of fields[i].frequencies.keys()) seen.add(term);
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
      entries.set(id, { id, concept, fields: fieldsFor(id, concept) });
    }
    return entries;
  }

  /**
   * Bring the index in line with the contributing snapshots.
   * `contributing`: [{ name, level, gen, ids, concepts }] in layer order.
   */
  function update(contributing) {
    if (!layers || !stats) {
      layers = new Map();
      stats = { total: 0, fieldTotals: Array.from({ length: FIELD_COUNT }, () => 0), documentFrequency: new Map() };
      for (const view of contributing) {
        const entries = buildLayerEntries(view);
        for (const entry of entries.values()) addToStats(entry.fields);
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
        if (before) removeFromStats(before.fields);
        addToStats(entry.fields);
      }
      for (const [id, before] of old) {
        if (!entries.has(id)) removeFromStats(before.fields);
      }
      if (previous) layers.delete(view.name);
      next.set(view.name, { gen: view.gen, level: view.level, entries });
    }
    // Layers that left the manifest: their documents leave the statistics.
    for (const [, gone] of layers) {
      for (const entry of gone.entries.values()) removeFromStats(entry.fields);
    }
    layers = next;
  }

  function armEviction() {
    clearTimeout(evictTimer);
    evictTimer = setTimeout(() => {
      layers = null;
      stats = null; // the WeakMap keeps per-concept analysis; only the corpus-scale assembly drops
    }, idleEvictMs);
    evictTimer.unref?.();
  }

  return {
    /**
     * Same answer shape, order and scores as searchConcepts(views, ...) over
     * the same snapshots — see the header for why that equality holds.
     */
    search(contributing, { query, limit = 10 }) {
      const rawTokens = tokenizeQuery(query);
      if (!query || typeof query !== "string" || rawTokens.length === 0) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      update(contributing);
      armEviction();
      const terms = [...new Set(analyze(query))];
      const index = {
        total: stats.total,
        averageLength: stats.fieldTotals.map((sum) => (stats.total ? sum / stats.total : 0)),
        documentFrequency: stats.documentFrequency,
      };
      const levelByName = new Map(contributing.map((view) => [view.name, view.level]));
      const orderLayerNames = (names) =>
        [...new Set(names)].sort((a, b) => (levelByName.get(b) ?? 0) - (levelByName.get(a) ?? 0));

      const byId = new Map();
      for (const view of contributing) {
        const layer = layers.get(view.name);
        if (!layer) continue;
        for (const entry of layer.entries.values()) {
          const score = scoreEntry(index, entry, terms);
          if (score <= 0) continue;
          const existing = byId.get(entry.id);
          if (!existing) {
            byId.set(entry.id, {
              id: entry.id,
              title: entry.concept.frontmatter.title ?? null,
              score,
              layers: [view.name],
              // Deferred: bodies are not retained by the index, and only hits
              // need one. Resolved to text after the cut below.
              snippetOf: entry.concept,
            });
          } else {
            if (score > existing.score) {
              existing.score = score;
              existing.snippetOf = entry.concept;
            }
            existing.layers.push(view.name);
            if (!existing.title) existing.title = entry.concept.frontmatter.title ?? null;
          }
        }
      }
      return [...byId.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Number(limit) || 10)
        .map(({ snippetOf, ...hit }) => ({
          ...hit,
          snippet: makeSnippet(conceptBody(snippetOf), rawTokens),
          layers: orderLayerNames(hit.layers),
        }));
    },
    close() {
      clearTimeout(evictTimer);
      layers = null;
      stats = null;
    },
  };
}
