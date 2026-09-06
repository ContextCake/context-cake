// Process-local retrieval for stdio clients. A process owns one selected
// profile's adapters: no cache or index can cross that profile boundary.
// Each query rechecks source listings; local fingerprints avoid rereading and
// reanalyzing unchanged files. Remote sources without fingerprints keep their
// own freshness policy, and equal parsed documents reuse their old analysis.
import { isDeepStrictEqual } from "node:util";
import { setImmediate as yieldNow } from "node:timers/promises";
import { createSearchIndex } from "./search-index.mjs";
import { tokenizeQuery } from "./search.mjs";

function sameFile(a, b) {
  return Boolean(a) && a.rel === b.rel && a.ext === b.ext
    && a.size === b.size && a.mtimeMs === b.mtimeMs
    && a.authoredDate === b.authoredDate;
}

export function createRetainedSearch(sources, { idleEvictMs = 60_000, sourceBudgetMs = 1_800_000 } = {}) {
  const index = createSearchIndex({ idleEvictMs });
  let snapshots = [];
  let refreshing = null;
  let eviction = null;
  let generation = 0;
  let closed = false;
  let activeSearches = 0;

  async function readSource(source, previous) {
    const signal = AbortSignal.timeout(sourceBudgetMs);
    const release = source.beginBatch?.();
    try {
      const fingerprinted = typeof source.listEntries === "function";
      const items = fingerprinted ? await source.listEntries({ signal })
        : (await source.listConceptIds({ signal })).map((id) => ({ id }));
      const concepts = new Map();
      const fileMeta = new Map();
      let unchanged = previous?.ids.length === items.length;
      for (const [i, item] of items.entries()) {
        signal.throwIfAborted();
        const before = previous?.concepts.get(item.id);
        let concept;
        if (before && fingerprinted && sameFile(previous.fileMeta.get(item.id), item)) {
          concept = before;
        } else {
          concept = await source.loadConcept(item.id, { signal, ...(item.ext ? { ext: item.ext } : {}) });
          signal.throwIfAborted();
          // Remote adapters may return a fresh object for identical content.
          if (before && isDeepStrictEqual(before, concept)) concept = before;
        }
        concepts.set(item.id, concept);
        fileMeta.set(item.id, item);
        unchanged &&= previous.ids[i] === item.id && before === concept;
        if (i % 64 === 63) await yieldNow();
      }
      signal.throwIfAborted();
      if (unchanged) return previous;
      const ids = items.map((item) => item.id);
      return {
        name: source.name, level: source.level, gen: ++generation, ids, concepts, fileMeta,
        async listConceptIds() { return ids; },
        async loadConcept(id) { return concepts.get(id) ?? null; },
      };
    } finally {
      release?.();
    }
  }

  async function refresh() {
    if (closed) throw new Error("Retrieval index is closed");
    clearTimeout(eviction);
    if (!refreshing) {
      refreshing = (async () => {
        // Bounded to one source at a time, matching the former MCP collection
        // path. Concurrent queries share this pass rather than duplicate it.
        const next = [];
        for (const [i, source] of sources.entries()) next.push(await readSource(source, snapshots[i]));
        if (!closed) snapshots = next;
        return next;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  return {
    async search(options) {
      if (typeof options?.query !== "string" || !tokenizeQuery(options.query).length) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      activeSearches++;
      try {
        const views = await refresh();
        if (closed) throw new Error("Retrieval index is closed");
        const hits = index.search(views, options);
        return { hits, sources: views };
      } finally {
        activeSearches--;
        // A failed refresh cleared the old idle timer too. Rearm after the
        // last caller settles, successful or not, or the previous parsed
        // corpus stays retained forever after a timeout/unreadable listing.
        // Another active caller must finish before its idle period begins.
        if (!closed && activeSearches === 0) {
          clearTimeout(eviction);
          eviction = setTimeout(() => {
            snapshots = [];
            index.close();
          }, idleEvictMs);
          eviction.unref?.();
        }
      }
    },
    close() {
      closed = true;
      clearTimeout(eviction);
      snapshots = [];
      index.close();
    },
  };
}
