// memory-pressure.mjs: the watermark that gates new indexing passes
// (service.mjs's indexQueue) and the app-facing signal in /api/status.

import test from "node:test";
import assert from "node:assert/strict";
import { memorySnapshot, memoryPressureLevel } from "../src/memory-pressure.mjs";

test("memorySnapshot reports a coherent shape on this real machine", () => {
  const snap = memorySnapshot();
  assert.ok(["normal", "elevated", "critical"].includes(snap.level));
  assert.ok(snap.totalBytes > 0);
  assert.ok(snap.liveBytes > 0);
  assert.ok(snap.liveFraction >= 0);
  // A node --test process is tens of MB against a real machine's total RAM —
  // this pins the common case rather than the watermark math.
  assert.equal(snap.level, "normal");
});

test("memoryPressureLevel is exactly memorySnapshot().level", () => {
  assert.equal(memoryPressureLevel(), memorySnapshot().level);
});

// The "critical" branch is the one that actually changes behavior (it stops
// new indexing passes in service.mjs), and reading the real process/OS state
// can never deterministically exercise it in a test. The `read` injection
// seam exists for exactly this.
test("critical/elevated/normal are reachable and match the documented fractions", () => {
  const fixture = (liveBytes, totalBytes) => ({ read: () => ({ liveBytes, totalBytes }) });

  assert.equal(memorySnapshot(fixture(10, 100)).level, "normal"); // 10%
  assert.equal(memorySnapshot(fixture(12, 100)).level, "elevated"); // exactly the elevated line
  assert.equal(memorySnapshot(fixture(20, 100)).level, "elevated"); // 20%
  assert.equal(memorySnapshot(fixture(25, 100)).level, "critical"); // exactly the critical line
  assert.equal(memorySnapshot(fixture(90, 100)).level, "critical"); // 90%
});

test("is not sticky: a live reading that drops clears the level immediately", () => {
  // The whole point of moving off RSS: unlike a high-water mark, this must
  // read "normal" again the instant the injected reading says so, with no
  // decay, no hysteresis, and no memory of the previous call.
  let liveBytes = 90;
  const snap = () => memorySnapshot({ read: () => ({ liveBytes, totalBytes: 100 }) });
  assert.equal(snap().level, "critical");
  liveBytes = 5;
  assert.equal(snap().level, "normal");
});

test("a zero-total reading (no crash, defensive) reports normal rather than dividing by zero", () => {
  assert.equal(memorySnapshot({ read: () => ({ liveBytes: 999, totalBytes: 0 }) }).level, "normal");
});

// The heap signal: heapUsed against the V8 ceiling the process would actually
// die at. It exists because the system fraction alone is unreachable below
// V8's default heap limit on any machine with ≥16GB RAM — the watermark could
// never fire before the OOM it guards against.
test("heap fraction trips the level even when the system fraction is calm", () => {
  const fixture = (heapUsedBytes, heapLimitBytes) => ({
    // 1% of system RAM — far under the live watermarks on its own.
    read: () => ({ liveBytes: 1, totalBytes: 100, heapUsedBytes, heapLimitBytes }),
  });

  assert.equal(memorySnapshot(fixture(50, 100)).level, "normal"); // 50% of the ceiling
  assert.equal(memorySnapshot(fixture(60, 100)).level, "elevated"); // exactly the elevated line
  assert.equal(memorySnapshot(fixture(79, 100)).level, "elevated");
  assert.equal(memorySnapshot(fixture(80, 100)).level, "critical"); // exactly the critical line
  assert.equal(memorySnapshot(fixture(95, 100)).level, "critical");
});

test("the worse of the two signals wins in both directions", () => {
  // Heap calm, system squeezed (external bytes / jetsam territory).
  assert.equal(
    memorySnapshot({ read: () => ({ liveBytes: 30, totalBytes: 100, heapUsedBytes: 10, heapLimitBytes: 100 }) }).level,
    "critical",
  );
  // System calm, heap near the abort line.
  assert.equal(
    memorySnapshot({ read: () => ({ liveBytes: 1, totalBytes: 100, heapUsedBytes: 85, heapLimitBytes: 100 }) }).level,
    "critical",
  );
  // One elevated, one normal — elevated wins.
  assert.equal(
    memorySnapshot({ read: () => ({ liveBytes: 1, totalBytes: 100, heapUsedBytes: 65, heapLimitBytes: 100 }) }).level,
    "elevated",
  );
});

test("a reading without heap fields behaves exactly as before the heap signal existed", () => {
  // The injection seam's compatibility promise: old fixtures never see the
  // heap signal, and the snapshot says so honestly with nulls.
  const snap = memorySnapshot({ read: () => ({ liveBytes: 10, totalBytes: 100 }) });
  assert.equal(snap.level, "normal");
  assert.equal(snap.heapUsedBytes, null);
  assert.equal(snap.heapLimitBytes, null);
  assert.equal(snap.heapFraction, 0);
});

test("the real reading carries the measured heap ceiling", () => {
  const snap = memorySnapshot();
  assert.ok(snap.heapLimitBytes > 0, "heap_size_limit is measured, not configured");
  assert.ok(snap.heapUsedBytes > 0);
  assert.ok(snap.heapFraction > 0 && snap.heapFraction < 1);
});
