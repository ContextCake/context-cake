// Cache wrapper: memoizes any source adapter's reads with a TTL, optionally
// persisted to disk so a cold process can serve within TTL. Exists because
// mcp-server's search/list/get_links sweep every source per call — remote
// adapters need it. Wrapper-style and opt-in per layer, so local adapters
// stay uncached by default.

import fs from "node:fs";
import path from "node:path";

// Entries per source, in memory, before the least-recently-used one is
// evicted. Without a cap the memory Map grows for the life of the process: a
// TTL only invalidates a key on the read that happens to hit it again, so a
// concept id read once and never revisited (an MCP graph churning over a
// long-running desktop session, say) stayed in memory forever. The number is
// generous on purpose — a layer's own document count is the natural ceiling
// for how much this ever needs to hold, and evicting a live source's cache
// mid-use would just turn into extra reads through it, not a correctness bug.
const DEFAULT_MAX_ENTRIES = 5000;

export function withCache(source, { ttlMs = 300000, cacheDir = null, namespace = null, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const memory = new Map(); // cache key -> { value, storedAt }, insertion order = recency (see touch())
  // The listing answer lives outside the capped map, on its own. A full index
  // sweep calls listConceptIds exactly once and loadConcept once per id after
  // it, so "list.v2" is always the OLDEST entry by the time a source with
  // >= maxEntries concepts finishes its first sweep — LRU eviction would throw
  // it away first, on every single pass, which is exactly the single most
  // expensive thing withCache exists to save (a full GitHub tree sweep, an
  // MCP list_nodes call) on exactly the remote-adapter workload it targets.
  // One entry, so there is no cap to enforce here.
  let listEntry = null;
  // Per-source subdir; encodeURIComponent keeps ids (which may contain "/")
  // as single safe filenames — nothing can traverse out of cacheDir.
  // Profile-aware callers add an opaque source fingerprint before the display
  // name. Legacy/direct callers retain the original on-disk layout.
  const dir = cacheDir
    ? path.join(cacheDir, ...(namespace ? [safeCacheSegment(namespace)] : []), safeCacheSegment(source.name))
    : null;

  function memoryKey(key) {
    return namespace ? `${namespace}\0${key}` : key;
  }

  function diskPath(key) {
    return path.join(dir, `${encodeURIComponent(key)}.json`);
  }

  function readDisk(key) {
    if (!dir) return null;
    try {
      const stat = fs.statSync(diskPath(key));
      if (Date.now() - stat.mtimeMs >= ttlMs) return null; // file mtime = entry age
      return { value: JSON.parse(fs.readFileSync(diskPath(key), "utf8")), storedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  function writeDisk(key, value) {
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${diskPath(key)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, diskPath(key)); // atomic: a reader never sees a partial entry
    } catch {
      // a cache write failure must never break the read that produced the value
    }
  }

  // Marks `entry` as the most recently used: re-inserting a Map key moves it
  // to the end of iteration order, which is what lets eviction below just
  // drop from the front. Then evicts down to `maxEntries` if this push was
  // the one that went over — a single cap check per write, never a sweep.
  function touch(scopedKey, entry) {
    memory.delete(scopedKey);
    memory.set(scopedKey, entry);
    // The `size > 0` half is what keeps this from spinning forever if
    // maxEntries is ever passed as 0 or negative: at size 0 the "oldest key"
    // is undefined, memory.delete(undefined) is a no-op, and size stays 0
    // forever without it — a non-positive maxEntries degenerates to
    // effectively-uncached instead of hanging the process.
    while (memory.size > maxEntries && memory.size > 0) {
      memory.delete(memory.keys().next().value);
    }
  }

  async function cached(key, load) {
    const scopedKey = memoryKey(key);
    const hit = memory.get(scopedKey);
    if (hit && Date.now() - hit.storedAt < ttlMs) {
      touch(scopedKey, hit); // a read counts as recent use
      return hit.value;
    }
    const disk = readDisk(key);
    if (disk) {
      touch(scopedKey, disk);
      return disk.value;
    }
    const value = await load();
    touch(scopedKey, { value, storedAt: Date.now() });
    writeDisk(key, value);
    return value;
  }

  // The listing's own memo, deliberately not routed through cached()/touch()
  // — see the comment on `listEntry` above.
  async function cachedList(key, load) {
    if (listEntry && Date.now() - listEntry.storedAt < ttlMs) return listEntry.value;
    const disk = readDisk(key);
    if (disk) { listEntry = disk; return disk.value; }
    const value = await load();
    listEntry = { value, storedAt: Date.now() };
    writeDisk(key, value);
    return value;
  }

  const wrapped = {
    name: source.name,
    level: source.level,
    lastSynced: null,
    async loadConcept(id) {
      return cached(`concept:${id}`, () => source.loadConcept(id));
    },
    /**
     * Every argument goes through, and what the walk could not read comes back
     * out even on a cache hit.
     *
     * Taking no arguments cost the wrapped source both of them, and withCache
     * wraps ANY kind — a local folder with a `cache` block included. So a
     * cached local layer's walk was unabortable (a cancelled index kept reading
     * to the end, and a churning layer stacked one live walk per cancelled
     * job), and its `notes` never arrived, which meant an oversized document or
     * a permission-blocked subtree indexed silently partial: zero warnings on a
     * source that is missing documents.
     *
     * The notes are cached WITH the ids for the same reason. They describe the
     * listing, so serving the listing from a memo while dropping them would
     * make the warnings flicker off on the second read.
     */
    async listConceptIds(options = {}) {
      const notes = options?.notes ?? null;
      const entry = await cachedList("list.v2", async () => {
        const collected = { skipped: [], unreadable: [], hidden: 0 };
        const ids = await source.listConceptIds({ ...options, notes: collected });
        return { ids, notes: collected };
      });
      if (notes) {
        for (const item of entry.notes?.skipped ?? []) notes.skipped?.push(item);
        for (const item of entry.notes?.unreadable ?? []) notes.unreadable?.push(item);
        // A count, not a list — unlike skipped/unreadable this only ever holds
        // a number (see okf-local's walkDocs), so a cache hit has to add it
        // rather than push, or a layer's hidden count would read 0 on every
        // read except the one that actually walked the disk.
        notes.hidden = (notes.hidden ?? 0) + (entry.notes?.hidden ?? 0);
      }
      return entry.ids;
    },
    // Deliberately NOT cached: health() reports whether the last real request
    // failed, so answering it from a memo taken before the outage would defeat
    // the one question it exists to answer.
    health() {
      return source.health?.() ?? null;
    },
    // Drop everything cached (memory + disk) so the next reads hit the source.
    // Remote adapters keep their own index memo, so the refresh has to reach
    // them too or a user-triggered Sync only clears the outer half.
    sync() {
      memory.clear();
      listEntry = null;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      source.sync?.();
      wrapped.lastSynced = new Date().toISOString();
      return wrapped.lastSynced;
    },
    close() {
      return source.close();
    },
  };
  return wrapped;
}

// encodeURIComponent leaves dots untouched, so a complete segment of "." or
// ".." would regain filesystem meaning when passed to path.join. Encode those
// two cases explicitly while keeping ordinary source-name cache paths stable.
function safeCacheSegment(value) {
  const encoded = encodeURIComponent(String(value));
  if (encoded === "") return "%00";
  if (encoded === ".") return "%2E";
  if (encoded === "..") return "%2E%2E";
  return encoded;
}
