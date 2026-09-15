// Process-local retrieval for stdio clients. A process owns one selected
// profile's adapters: no cache or index can cross that profile boundary.
//
// Backed by search-store.mjs when node:sqlite is available (the normal case):
// parsed documents are NOT retained in the JS heap between queries. Each
// query asks the store which ids it doesn't already have a matching
// fingerprint for (store.pending()), loads ONLY those, and hands the store a
// view whose `concepts` map holds just the newly-loaded documents — every
// other document's postings are already on disk and untouched. Only the tiny
// per-layer fileMeta maps are retained in the JS heap between queries (a few
// hundred bytes per document, not the parsed content), so a process that has
// answered many queries against an unchanged vault is no heavier than one
// that has answered one.
//
// Falls back to the old in-memory createSearchIndex-backed implementation
// (every parsed concept retained, idle-evicted) when node:sqlite isn't
// available in this runtime, or the store fails to open.
import { setImmediate as yieldNow } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createSearchIndex } from "./search-index.mjs";
import { createSearchStore, isSearchStoreAvailable } from "./search-store.mjs";
import { tokenizeQuery } from "./search.mjs";

function sameFile(a, b) {
  return Boolean(a) && a.rel === b.rel && a.ext === b.ext
    && a.size === b.size && a.mtimeMs === b.mtimeMs
    && a.authoredDate === b.authoredDate;
}

export function createRetainedSearch(sources, options = {}) {
  if (isSearchStoreAvailable()) {
    try {
      return createStoreRetainedSearch(sources, options);
    } catch (error) {
      process.stderr.write(`[retained-search] falling back to in-memory retained search: ${error.message}\n`);
    }
  }
  return createLegacyRetainedSearch(sources, options);
}

// ---- store-backed (default) ------------------------------------------------

function createStoreRetainedSearch(sources, {
  file, sourceBudgetMs = 1_800_000, identities,
} = {}) {
  const store = createSearchStore({ file: file ?? ":memory:" });
  // Per-layer fileMeta from the last query, kept ONLY to cheaply recognize
  // "nothing moved" and reuse the same `gen` — that lets search-store's own
  // sync() take its fast path (skip the per-id fingerprint compare) instead
  // of re-walking every stored row on every query. Never holds concepts.
  const fileMetaByName = new Map();
  const genByName = new Map();
  let generation = 0;
  let refreshing = null;
  let closed = false;
  let documentsRead = 0; // instrumentation: loadConcept calls since open (tests, benchmark)

  function identityFor(source) {
    return identities?.get(source.name) ?? source.name;
  }

  async function buildView(source) {
    const signal = AbortSignal.timeout(sourceBudgetMs);
    const release = source.beginBatch?.();
    try {
      const fingerprinted = typeof source.listEntries === "function";
      const items = fingerprinted ? await source.listEntries({ signal })
        : (await source.listConceptIds({ signal })).map((id) => ({ id }));
      const ids = items.map((item) => item.id);
      const fileMeta = fingerprinted ? new Map(items.map((item) => [item.id, item])) : undefined;
      const identity = identityFor(source);

      const previousMeta = fileMetaByName.get(source.name);
      let unchanged = fingerprinted && Boolean(previousMeta) && previousMeta.size === items.length;
      if (unchanged) {
        for (const item of items) {
          if (!sameFile(previousMeta.get(item.id), item)) { unchanged = false; break; }
        }
      }
      const gen = (fingerprinted && unchanged) ? (genByName.get(source.name) ?? ++generation) : ++generation;
      genByName.set(source.name, gen);

      const pendingIds = store.pending({
        name: source.name, identity, ids, fileMeta,
      });
      const concepts = new Map();
      for (const [i, id] of pendingIds.entries()) {
        signal.throwIfAborted();
        const item = fileMeta?.get(id);
        const concept = await source.loadConcept(id, { signal, ...(item?.ext ? { ext: item.ext } : {}) });
        signal.throwIfAborted();
        concepts.set(id, concept);
        documentsRead += 1;
        if (i % 64 === 63) await yieldNow();
      }
      signal.throwIfAborted();

      if (fingerprinted) fileMetaByName.set(source.name, fileMeta);
      else fileMetaByName.delete(source.name);

      return {
        name: source.name, level: source.level, identity, gen, ids, concepts, fileMeta,
      };
    } finally {
      release?.();
    }
  }

  async function refresh() {
    if (closed) throw new Error("Retrieval index is closed");
    if (!refreshing) {
      refreshing = (async () => {
        // Bounded to one source at a time, matching the former MCP collection
        // path. Concurrent queries share this pass rather than duplicate it.
        const views = [];
        for (const source of sources) views.push(await buildView(source));
        return views;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  return {
    async search(searchOptions) {
      if (typeof searchOptions?.query !== "string" || !tokenizeQuery(searchOptions.query).length) {
        throw new Error("search requires a non-empty query string with at least one searchable token");
      }
      const views = await refresh();
      if (closed) throw new Error("Retrieval index is closed");
      const hits = store.search(views, searchOptions);
      // The real adapters, not synthetic view wrappers: contested-hit
      // resolves (mcp-server.mjs's annotateContested, ≤5 hits) read live
      // through these rather than against a point-in-time snapshot map.
      return { hits, sources };
    },
    close() {
      closed = true;
      store.close();
    },
    // Test/benchmark instrumentation only — harmless to leave in production.
    _debug: {
      get documentsRead() { return documentsRead; },
    },
  };
}

// ---- legacy in-memory fallback (no node:sqlite) ----------------------------

function createLegacyRetainedSearch(sources, { idleEvictMs = 60_000, sourceBudgetMs = 1_800_000 } = {}) {
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
