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
//
// Two SIGNALS, and the worse one wins. The original single signal — live
// bytes as a fraction of total system RAM — is also rejected as the only
// gauge, because it is unreachable on the machines that matter: 25% of a
// 32GB Mac is 8GB of live heap, and V8 aborts the process at its own
// heap_size_limit (~4.2GB by default — a ceiling the desktop app cannot
// raise; Electron ignores every utilityProcess heap flag, probed 2026-08-12)
// long before the fraction trips. A watermark that only fires above the
// crash line is a net hung above the ceiling. So the heap signal — heapUsed
// against the measured heap_size_limit — is the one that actually guards the
// OOM, and the system fraction stays for what the heap signal cannot see:
// `external` (Buffers) lives outside the V8 heap, and a machine-wide squeeze
// (jetsam) does not care which limit was going to be hit first.

import os from "node:os";
import v8 from "node:v8";

const ELEVATED_LIVE_FRACTION = 0.12; // this process alone holds >12% of total RAM in live+external bytes
const CRITICAL_LIVE_FRACTION = 0.25; // >25%
const ELEVATED_HEAP_FRACTION = 0.60; // heapUsed at >60% of the V8 ceiling this process dies at
const CRITICAL_HEAP_FRACTION = 0.80; // >80% — the GC-thrash zone right under the abort

function realRead() {
  const mem = process.memoryUsage();
  return {
    totalBytes: os.totalmem(),
    liveBytes: mem.heapUsed + mem.external,
    // The V8 ceiling this process will actually die at — measured, not
    // configured, because the host may not be able to configure it at all
    // (Electron 43's utilityProcess ignores execArgv/NODE_OPTIONS heap flags;
    // probed 2026-08-12, fixed at ~4.2GB). Surfaced through /api/status as
    // memoryDetail so the app and tests can see how close a pass is running.
    heapUsedBytes: mem.heapUsed,
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  };
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
  // Injected readings (tests) may omit the heap fields; they default to null,
  // the heap signal sits out, and the level is the system fraction alone —
  // exactly the pre-heap-signal behavior, so old fixtures stay valid.
  const { totalBytes, liveBytes, heapUsedBytes = null, heapLimitBytes = null } = read();
  const liveFraction = totalBytes > 0 ? liveBytes / totalBytes : 0;
  const heapFraction = heapLimitBytes > 0 ? (heapUsedBytes ?? 0) / heapLimitBytes : 0;
  const rank = (fraction, elevated, critical) =>
    fraction >= critical ? 2 : fraction >= elevated ? 1 : 0;
  const worst = Math.max(
    rank(liveFraction, ELEVATED_LIVE_FRACTION, CRITICAL_LIVE_FRACTION),
    rank(heapFraction, ELEVATED_HEAP_FRACTION, CRITICAL_HEAP_FRACTION),
  );
  const level = worst === 2 ? "critical" : worst === 1 ? "elevated" : "normal";
  return { level, liveBytes, totalBytes, liveFraction, heapUsedBytes, heapLimitBytes, heapFraction };
}

/** Just the level ("normal" | "elevated" | "critical") — the common case. */
export function memoryPressureLevel(opts) {
  return memorySnapshot(opts).level;
}
