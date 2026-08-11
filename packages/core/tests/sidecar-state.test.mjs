import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSidecarMigrated, sidecarDir, sidecarRoot } from "../src/sidecar-state.mjs";
import { createConflictResolutionLog, createDiscrepancyTransactionJournal } from "../src/conflict-resolutions.mjs";
import { createDiscrepancyPriorityStore } from "../src/discrepancy-priorities.mjs";
import { createDiscrepancyRuleStore } from "../src/discrepancy-rules.mjs";

async function tempManifest(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sidecar-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "manifest.json");
}

test("sidecarDir scopes per profile and refuses ids that are not profile ids", async (t) => {
  const manifest = await tempManifest(t);
  assert.equal(sidecarDir(manifest), path.join(sidecarRoot(manifest), "profiles", "default"));
  assert.equal(sidecarDir(manifest, "work"), path.join(sidecarRoot(manifest), "profiles", "work"));
  for (const bad of ["..", "a/b", "a\\b", ".hidden", "", null, "UPPER"]) {
    assert.throws(() => sidecarDir(manifest, bad), /Invalid profile id/);
  }
});

test("fresh setups write straight into profiles/default", async (t) => {
  const manifest = await tempManifest(t);
  const store = createDiscrepancyPriorityStore(manifest);
  await store.set("d1", "high");
  assert.equal(store.file, path.join(sidecarRoot(manifest), "profiles", "default", "discrepancy-priorities.json"));
  assert.deepEqual(await store.list(), { d1: "high" });
});

test("unscoped legacy state migrates to profiles/default and survives the move", async (t) => {
  const manifest = await tempManifest(t);
  const root = sidecarRoot(manifest);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "discrepancy-priorities.json"), `${JSON.stringify({ version: 1, priorities: { d1: "low" } })}\n`);
  await fs.writeFile(path.join(root, "conflict-resolutions.ndjson"), `${JSON.stringify({ schemaVersion: 1, id: "r1" })}\n`);
  // A stray tmp file from an interrupted atomic write must be left behind.
  await fs.writeFile(path.join(root, "discrepancy-priorities.json.dead.tmp"), "{}");

  const priorities = createDiscrepancyPriorityStore(manifest);
  assert.deepEqual(await priorities.list(), { d1: "low" });
  const log = createConflictResolutionLog(manifest);
  assert.equal((await log.find("r1")).id, "r1");

  const rootEntries = await fs.readdir(root);
  assert.ok(!rootEntries.includes("discrepancy-priorities.json"), "unscoped file should have moved");
  assert.ok(!rootEntries.includes("conflict-resolutions.ndjson"), "unscoped log should have moved");
  assert.ok(rootEntries.includes("discrepancy-priorities.json.dead.tmp"), "stray tmp files stay put");
  const markers = await fs.readdir(path.join(root, "profiles"));
  assert.ok(markers.includes(".migrated-to-profiles"));
});

test("a crashed half-migration completes on the next run", async (t) => {
  const manifest = await tempManifest(t);
  const root = sidecarRoot(manifest);
  // Simulate a crash after one rename: rules already scoped, journal not, no marker.
  await fs.mkdir(path.join(root, "profiles", "default"), { recursive: true });
  await fs.writeFile(path.join(root, "profiles", "default", "discrepancy-rules.json"), `${JSON.stringify({ version: 1, rules: [] })}\n`);
  await fs.writeFile(path.join(root, "discrepancy-transactions.ndjson"), `${JSON.stringify({ id: "t1", state: "committed" })}\n`);

  const journal = createDiscrepancyTransactionJournal(manifest);
  assert.equal((await journal.list())[0].id, "t1");
  assert.deepEqual(await createDiscrepancyRuleStore(manifest).list(), []);
  const rootEntries = await fs.readdir(root);
  assert.ok(!rootEntries.includes("discrepancy-transactions.ndjson"));
});

test("state in both layouts is a refusal, never a guess", async (t) => {
  const manifest = await tempManifest(t);
  const root = sidecarRoot(manifest);
  await fs.mkdir(path.join(root, "profiles", "default"), { recursive: true });
  await fs.writeFile(path.join(root, "discrepancy-priorities.json"), `${JSON.stringify({ version: 1, priorities: { d1: "low" } })}\n`);
  await fs.writeFile(path.join(root, "profiles", "default", "discrepancy-priorities.json"), `${JSON.stringify({ version: 1, priorities: { d1: "high" } })}\n`);

  await assert.rejects(createDiscrepancyPriorityStore(manifest).list(), /both layouts/);
  // Still refusing on retry — a rejected migration must not be cached as done.
  await assert.rejects(createDiscrepancyPriorityStore(manifest).list(), /both layouts/);
});

test("profiles do not see each other's state", async (t) => {
  const manifest = await tempManifest(t);
  await createDiscrepancyPriorityStore(manifest, { profileId: "work" }).set("d1", "high");
  assert.deepEqual(await createDiscrepancyPriorityStore(manifest, { profileId: "home" }).list(), {});
  assert.deepEqual(await createDiscrepancyPriorityStore(manifest).list(), {});

  const log = createConflictResolutionLog(manifest, { profileId: "work" });
  await log.append({ id: "r1" });
  assert.deepEqual(await createConflictResolutionLog(manifest, { profileId: "home" }).list(), []);
  assert.equal((await log.find("r1")).id, "r1");
});
