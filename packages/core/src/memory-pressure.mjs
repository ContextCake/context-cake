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
// 3.7%, which a naive threshold reads as "critical" permanently.
//
// Also deliberately NOT based on RSS, which a first version of this file used
// and which has the same sticky failure in a different place: V8 rarely
// returns heap pages to the OS after a large allocation, so RSS is a
// high-water mark, not a live reading — once an index pass over a big vault
// pushed it past the critical line, it stayed there for the rest of the
// process's life even after every object involved was garbage. The banner
// this feeds promises "this clears on its own once memory frees up"; RSS
// cannot honor that promise. `heapUsed` is the number that actually falls
// after a GC pass reclaims dead objects, so pressure here tracks LIVE
// allocation instead of the process's historical peak. `external` rides
// along because it is the other bucket the tokenizer/parsing work actually
// grows (Buffers, ArrayBuffers bound to JS objects) and is reclaimed the same
// way. Both figures come from the SAME process.memoryUsage() call the RSS
// version used, so this costs nothing extra to read.
//
// Two watermarks, not one: "elevated" is a soft signal a caller may use to
// show a banner or slow its own polling; "critical" is the one that actually
// stops new passes from starting.

import os from "node:os";

const ELEVATED_LIVE_FRACTION = 0.12; // this process alone holds >12% of total RAM in live+external bytes
const CRITICAL_LIVE_FRACTION = 0.25; // >25%

function realRead() {
  const mem = process.memoryUsage();
  return { totalBytes: os.totalmem(), liveBytes: mem.heapUsed + mem.external };
}

/**
 * A snapshot of current memory pressure. Cheap — safe to call per request.
 *
 * `read` is an injection seam for tests only: production code never passes
 * it, and the default reads the real process/OS state. Without it, the
 * "critical" branch — the one that actually changes indexing behavior — had
 * no way to be exercised deterministically in a test at all.
 */
export function memorySnapshot({ read = realRead } = {}) {
  const { totalBytes, liveBytes } = read();
  const liveFraction = totalBytes > 0 ? liveBytes / totalBytes : 0;
  const level = liveFraction >= CRITICAL_LIVE_FRACTION
    ? "critical"
    : liveFraction >= ELEVATED_LIVE_FRACTION
      ? "elevated"
      : "normal";
  return { level, liveBytes, totalBytes, liveFraction };
}

/** Just the level ("normal" | "elevated" | "critical") — the common case. */
export function memoryPressureLevel(opts) {
  return memorySnapshot(opts).level;
}
