// A persistent cache of BPE token counts, keyed by the hash of the EXACT
// text handed to countTokens.
//
// Why it exists: the o200k encode costs ~193–280ms per MB of real notes, and
// an engine restart re-pays it for the whole corpus — ~20 seconds of pure CPU
// on a 4,000-note vault whose counts cannot have changed. The incremental
// snapshot (service.mjs) already carries counts across passes WITHIN a
// session; this carries them across processes and restarts.
//
// Why the key is the tokenized text's own hash, not file bytes + a parser
// version: the count is a pure function of the text, so hashing the input
// makes the cache self-invalidating — a parser change changes the text,
// which changes the key. Nothing to remember to bump. SHA-256 over ~12KB is
// microseconds against the milliseconds it saves.
//
// Durability posture (same family as sidecar-state.mjs): append-only NDJSON,
// one atomic-ish appendFile per batch; readers tolerate torn or garbage
// lines (last write wins on duplicates); a header mismatch rotates the file
// aside and starts fresh; compaction rewrites tmp+rename behind an O_EXCL
// lockfile and is skipped on contention. Two engines (the app's and the
// CLI's) may share one file — the worst possible race outcome is a lost
// cache line, never a wrong count served.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const HEADER = { format: "contextcake-token-cache", v: 1 };
const MAX_ENTRIES = 200_000; // ~20 vaults of 10k docs; ~16MB on disk at worst
const COMPACT_WHEN_LINES_EXCEED = 4; // x live entries — dupes dominate, rewrite

export function hashTokenText(tokenizer, text) {
  return createHash("sha256").update(tokenizer).update("\0").update(text).digest("hex").slice(0, 32);
}

export function createTokenCountCache({ file, tokenizer }) {
  let entries = null; // hash -> count, lazily loaded
  let loadedLines = 0;
  let pending = []; // lines awaiting append
  let appendTail = Promise.resolve(); // serializes writes
  const header = { ...HEADER, tokenizer };

  function load() {
    if (entries) return;
    entries = new Map();
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return; // no cache yet — everything misses, which is just a cold start
    }
    const lines = raw.split("\n");
    loadedLines = lines.length;
    let headerOk = false;
    for (const line of lines) {
      if (line === "") continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; } // torn line — a lost entry, not an error
      if (parsed.format === HEADER.format) {
        // A different version or tokenizer means every count in this file
        // describes a function we no longer run. Rotate it aside whole —
        // deleting history someone might want to inspect is not this
        // module's call — and start empty.
        if (parsed.v !== header.v || parsed.tokenizer !== header.tokenizer) {
          try { fs.renameSync(file, `${file}.superseded`); } catch { /* best effort */ }
          entries = new Map();
          loadedLines = 0;
          return;
        }
        headerOk = true;
        continue;
      }
      if (typeof parsed.h === "string" && Number.isFinite(parsed.n)) entries.set(parsed.h, parsed.n);
    }
    // A file with entries but no header predates the format or lost its first
    // line: treat it as foreign, same rotation.
    if (!headerOk && entries.size > 0) {
      try { fs.renameSync(file, `${file}.superseded`); } catch { /* best effort */ }
      entries = new Map();
      loadedLines = 0;
    }
  }

  function get(hash) {
    load();
    return entries.get(hash);
  }

  function put(hash, count) {
    load();
    if (entries.has(hash) || entries.size >= MAX_ENTRIES) return;
    entries.set(hash, count);
    pending.push(JSON.stringify({ h: hash, n: count }));
  }

  /** Land pending entries on disk. Awaitable, never throws. */
  function flush() {
    if (pending.length === 0) return appendTail;
    const batch = pending;
    pending = [];
    appendTail = appendTail.then(async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        let text = batch.join("\n") + "\n";
        let stat = null;
        try { stat = await fsp.stat(file); } catch { /* absent */ }
        if (!stat) text = JSON.stringify(header) + "\n" + text;
        await fsp.appendFile(file, text);
        loadedLines += batch.length;
        await maybeCompact();
      } catch {
        // A full disk or a read-only volume costs the cache, never the pass.
      }
    });
    return appendTail;
  }

  async function maybeCompact() {
    if (!entries || entries.size === 0) return;
    if (loadedLines < entries.size * COMPACT_WHEN_LINES_EXCEED && entries.size < MAX_ENTRIES) return;
    const lock = `${file}.lock`;
    let handle;
    try {
      handle = await fsp.open(lock, "wx");
    } catch {
      // Another engine is compacting (or a crash left a lock behind — clear
      // stale ones by age so one crash cannot disable compaction forever).
      try {
        const stat = await fsp.stat(lock);
        if (Date.now() - stat.mtimeMs > 60_000) await fsp.rm(lock, { force: true });
      } catch { /* raced — fine */ }
      return;
    }
    try {
      const lines = [JSON.stringify(header)];
      for (const [h, n] of entries) lines.push(JSON.stringify({ h, n }));
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, lines.join("\n") + "\n");
      await fsp.rename(tmp, file);
      loadedLines = lines.length;
    } catch { /* compaction is an optimization */ } finally {
      await handle.close().catch(() => {});
      await fsp.rm(lock, { force: true }).catch(() => {});
    }
  }

  return { get, put, flush, hash: (text) => hashTokenText(tokenizer, text) };
}
