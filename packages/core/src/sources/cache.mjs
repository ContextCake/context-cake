// Cache wrapper: memoizes any source adapter's reads with a TTL, optionally
// persisted to disk so a cold process can serve within TTL. Exists because
// mcp-server's search/list/get_links sweep every source per call — remote
// adapters need it. Wrapper-style and opt-in per layer, so local adapters
// stay uncached by default.

import fs from "node:fs";
import path from "node:path";

export function withCache(source, { ttlMs = 300000, cacheDir = null } = {}) {
  const memory = new Map(); // cache key -> { value, storedAt }
  // Per-source subdir; encodeURIComponent keeps ids (which may contain "/")
  // as single safe filenames — nothing can traverse out of cacheDir.
  const dir = cacheDir ? path.join(cacheDir, encodeURIComponent(source.name)) : null;

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

  async function cached(key, load) {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.storedAt < ttlMs) return hit.value;
    const disk = readDisk(key);
    if (disk) {
      memory.set(key, disk);
      return disk.value;
    }
    const value = await load();
    memory.set(key, { value, storedAt: Date.now() });
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
    async listConceptIds() {
      return cached("list", () => source.listConceptIds());
    },
    // Drop everything cached (memory + disk) so the next reads hit the source.
    // Remote adapters keep their own index memo, so the refresh has to reach
    // them too or a user-triggered Sync only clears the outer half.
    sync() {
      memory.clear();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      source.sync?.();
      wrapped.lastSynced = new Date().toISOString();
      return wrapped.lastSynced;
    },
    close() {
      source.close();
    },
  };
  return wrapped;
}
