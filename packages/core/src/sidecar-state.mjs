// Where profile-scoped durable sidecar state lives, and how the pre-profile
// unscoped layout migrates into it.
//
// Rules, priorities, resolution history, and transaction journals live beside
// the manifest under `.contextcake/profiles/<profile-id>/` so two profiles
// never share (or clobber) each other's decisions
// (specs/contextcake-control-plane/spec.md §5.3). The pre-profile layout kept
// those files directly under `.contextcake/`; the first store access moves
// them into `profiles/default/` — renames on the same filesystem, guarded by
// a completion marker, safe to re-run and safe to race from a second engine.
//
// The team-shared rules file inside a live layer root
// (`<live.root>/.contextcake/discrepancy-rules.json`) is NOT this state and is
// deliberately untouched: it rides the git live layer between teammates, whose
// profile ids differ by machine.

import fsp from "node:fs/promises";
import path from "node:path";
import { PROFILE_ID_PATTERN } from "./manifest.mjs";

// Every file the pre-profile layout could hold. A name not in this list never
// migrates — stray tmp files from interrupted atomic writes are inert garbage.
const UNSCOPED_FILES = [
  "discrepancy-rules.json",
  "discrepancy-priorities.json",
  "conflict-resolutions.ndjson",
  "discrepancy-transactions.ndjson",
];
const MARKER = ".migrated-to-profiles";

export function sidecarRoot(manifestPath) {
  return path.join(path.dirname(path.resolve(manifestPath)), ".contextcake");
}

export function sidecarDir(manifestPath, profileId = "default") {
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`Invalid profile id for sidecar state: ${JSON.stringify(profileId)}`);
  }
  return path.join(sidecarRoot(manifestPath), "profiles", profileId);
}

// One migration per sidecar root per process; concurrent stores share the
// promise. A rejected migration is retried on the next call rather than
// cached — a transient failure must not wedge every store until restart.
const migrations = new Map();

export function ensureSidecarMigrated(manifestPath) {
  const root = sidecarRoot(manifestPath);
  let pending = migrations.get(root);
  if (!pending) {
    pending = migrateUnscoped(root).catch((error) => {
      migrations.delete(root);
      throw error;
    });
    migrations.set(root, pending);
  }
  return pending;
}

async function migrateUnscoped(root) {
  const defaultDir = path.join(root, "profiles", "default");
  const marker = path.join(root, "profiles", MARKER);
  try {
    await fsp.access(marker);
    return; // already migrated (possibly by another process)
  } catch {}
  await fsp.mkdir(defaultDir, { recursive: true, mode: 0o700 });
  for (const name of UNSCOPED_FILES) {
    const oldPath = path.join(root, name);
    const newPath = path.join(defaultDir, name);
    const oldExists = await exists(oldPath);
    if (!oldExists) continue; // fresh setup, or this file already moved
    if (await exists(newPath)) {
      // Both layouts hold this file: an old engine kept writing the unscoped
      // path after a newer one migrated. The histories have forked; guessing
      // which one wins would silently discard decisions. Refuse until a human
      // (or a newer tool) reconciles them.
      throw new Error(
        `Sidecar state exists in both layouts: ${oldPath} and ${newPath}. `
        + "Reconcile the two files (they diverged while an older engine was running), "
        + "remove the unscoped one, and retry.",
      );
    }
    try {
      await fsp.rename(oldPath, newPath);
    } catch (error) {
      // A concurrent migration won the rename between our check and ours.
      if (error.code !== "ENOENT") throw error;
    }
  }
  const temp = `${marker}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify({ version: 1, migratedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, marker);
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}
