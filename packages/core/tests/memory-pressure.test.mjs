// memory-pressure.mjs: the watermark that gates new indexing passes
// (service.mjs's indexQueue) and the app-facing signal in /api/status.

import test from "node:test";
import assert from "node:assert/strict";
import { memorySnapshot, memoryPressureLevel } from "../src/memory-pressure.mjs";

test("memorySnapshot reports a coherent shape on this real machine", () => {
  const snap = memorySnapshot();
  assert.ok(["normal", "elevated", "critical"].includes(snap.level));
  assert.ok(snap.totalBytes > 0);
  assert.ok(snap.rssBytes > 0);
  assert.ok(snap.rssFraction >= 0);
  // A node --test process is tens of MB against a real machine's total RAM —
  // this pins the common case rather than the watermark math.
  assert.equal(snap.level, "normal");
});

test("memoryPressureLevel is exactly memorySnapshot().level", () => {
  assert.equal(memoryPressureLevel(), memorySnapshot().level);
});
