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
