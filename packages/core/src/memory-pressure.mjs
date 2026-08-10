// Memory-pressure awareness: a process.memoryUsage() watermark so background
// indexing degrades gracefully on a big manifest instead of piling on more
// concurrent passes until the process gets OOM-killed. Nothing here
// interrupts a pass already in flight — snapshotSource has no safe pause
// point mid-walk, and killing one loses the work it already paid for. This
// only gates the moment BEFORE a new pass is allowed to start (see
// service.mjs's indexQueue).
//
// Deliberately NOT based on os.freemem(): "free" memory on a real machine is
// mostly reclaimable page cache, not pressure — measured on the box this was
// written on, a totally idle 38GB machine reported freemem()/totalmem() at
// 3.7%, which a naive threshold reads as "critical" permanently. What
// actually predicts an OOM kill is how much of the system THIS process is
// holding, so the watermark is the engine's own RSS as a fraction of total
// system memory instead — a number page-cache behavior can't distort, and
// one that scales sanely from an 8GB laptop to a 128GB workstation without
// being tuned against either.
//
// Two watermarks, not one: "elevated" is a soft signal a caller may use to
// show a banner or slow its own polling; "critical" is the one that actually
// stops new passes from starting.

import os from "node:os";

const ELEVATED_RSS_FRACTION = 0.12; // this process alone holds >12% of total RAM
const CRITICAL_RSS_FRACTION = 0.25; // >25%

/** A snapshot of current memory pressure. Cheap — safe to call per request. */
export function memorySnapshot() {
  const totalBytes = os.totalmem();
  const rssBytes = process.memoryUsage().rss;
  const rssFraction = totalBytes > 0 ? rssBytes / totalBytes : 0;
  const level = rssFraction >= CRITICAL_RSS_FRACTION
    ? "critical"
    : rssFraction >= ELEVATED_RSS_FRACTION
      ? "elevated"
      : "normal";
  return { level, rssBytes, totalBytes, rssFraction };
}

/** Just the level ("normal" | "elevated" | "critical") — the common case. */
export function memoryPressureLevel() {
  return memorySnapshot().level;
}
