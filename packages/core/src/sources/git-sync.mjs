// Git-sync wrapper for live layers: TTL-gated pull before reads, read-time
// decay filter for captures/, and sync() that both refreshes and pushes any
// queued commits. Composes OUTSIDE withCache — the pull gate must run before
// cache lookups, and a real pull invalidates the inner cache via its sync().
//
// Also owns the live-layer manifest contract: at most one layer may declare
// "live": true, and it must be an okf-local layer with a "git" block.

import path from "node:path";
import { pull, retryQueued } from "./git-core.mjs";

const CAPTURE_PREFIX = "captures/";
const DAY_MS = 86400000;

export function withGitSync(source, { root, pullTtlMs = 90000, retentionDays = 14, now = Date.now } = {}) {
  let lastPulledAt = 0;

  async function maybePull(force = false) {
    if (!force && now() - lastPulledAt < pullTtlMs) return;
    const result = await pull(root);
    // Only advance the TTL clock when a pull actually ran. A lock-contention
    // skip must not suppress the next pull for a full TTL (which would let
    // reads serve stale well beyond the intended window under write pressure).
    if (result.skipped) return;
    lastPulledAt = now();
    if (result.changed) source.sync?.();
  }

  function expired(entry) {
    const captured = entry?.frontmatter?.captured;
    if (!captured) return false;
    const time = new Date(captured).getTime();
    if (Number.isNaN(time)) return false;
    return now() - time > retentionDays * DAY_MS;
  }

  const wrapped = {
    name: source.name,
    level: source.level,
    lastSynced: null,
    async loadConcept(id) {
      await maybePull();
      // Archived (decayed) captures stay readable by direct id.
      return source.loadConcept(id);
    },
    async listConceptIds() {
      await maybePull();
      const ids = await source.listConceptIds();
      const kept = [];
      for (const id of ids) {
        if (!id.startsWith(CAPTURE_PREFIX)) {
          kept.push(id);
          continue;
        }
        const entry = await source.loadConcept(id);
        if (!expired(entry)) kept.push(id);
      }
      return kept;
    },
    // Explicit sync: force-refresh AND land any offline-queued commits.
    async sync() {
      await retryQueued(root);
      await maybePull(true);
      wrapped.lastSynced = new Date(now()).toISOString();
      return wrapped.lastSynced;
    },
    close() {
      source.close();
    },
  };
  return wrapped;
}

// Narrow data facade over the manifest: callers get paths and config for the
// single live layer, never a mutable source. Mutations go through git-core.
export function resolveLiveLayer(manifest, manifestDir) {
  const live = (manifest.layers ?? []).filter((layer) => layer.live === true);
  if (live.length === 0) return null;
  if (live.length > 1) {
    throw new Error(`Manifest declares ${live.length} live layers (${live.map((l) => l.name).join(", ")}); exactly one is allowed`);
  }
  const layer = live[0];
  if ((layer.source ?? "okf-local") !== "okf-local") {
    throw new Error(`Live layer "${layer.name}" must be an okf-local bundle (got "${layer.source}")`);
  }
  if (!layer.git || typeof layer.git !== "object") {
    throw new Error(`Live layer "${layer.name}" requires a "git" block ({ pullTtlSeconds, retentionDays, profileName })`);
  }
  return {
    name: layer.name,
    root: path.resolve(manifestDir, layer.path),
    pullTtlMs: (Number(layer.git.pullTtlSeconds ?? 90)) * 1000,
    retentionDays: Number(layer.git.retentionDays ?? 14),
    profileName: layer.git.profileName ?? null,
  };
}
