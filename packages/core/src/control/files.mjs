// Editor mutations share the manifest lease, live-repository lock and durable
// transaction journal used by discrepancy decisions. Routes only parse/dispatch.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readContextManifest, getManifestProfileLayers, withManifestLockAsync } from "../manifest.mjs";
import { layerRootMap, parseLayerFilePath, relativeWithinRoot, stageFileTransaction, stageSectionTransaction } from "../layer-files.mjs";
import { parseJson } from "../http-util.mjs";
import { resolveLiveLayer } from "../sources/git-sync.mjs";
import { ControlError } from "./errors.mjs";

function inside(file, root) {
  const rel = relativeWithinRoot(file, root);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel));
}

export function createFileOperations({ manifestPath, profileId = "default", transactionJournal,
  ensureRecovery = async () => {}, git, onWritten = () => {} }) {
  const manifestDir = path.dirname(path.resolve(manifestPath));

  async function save(kind, rawBody) {
    const body = parseJson(rawBody);
    const outcome = await withManifestLockAsync(manifestPath, async () => {
      // Strict and fresh, after taking the lease: quarantine is read-only and
      // a concurrent source change must never retarget an editor save.
      const manifest = readContextManifest(manifestPath, { allowMissing: false });
      const layers = getManifestProfileLayers(manifest, profileId);
      const roots = layerRootMap({ layers }, manifestDir);
      const live = resolveLiveLayer(layers, manifestDir);
      await ensureRecovery();
      const requested = kind === "file" ? [parseLayerFilePath(body.path).layer]
        : Array.isArray(body.layers) ? body.layers : [];
      // Decide which lock is required from the configured roots, without
      // stat'ing/reading editor targets first. Include aliases and parents of
      // the live root; a layer name alone is not a filesystem boundary.
      const needsLive = live && requested.some((name) => {
        const root = roots.get(name)?.root;
        return root && (inside(root, live.root) || inside(live.root, root));
      });
      if (needsLive && !git) throw new ControlError("GIT_UNAVAILABLE", "This host cannot commit into the live team layer.");
      const id = randomUUID();
      let staged = null;
      let response;
      let livePaths = [];
      let committed = false;
      let rolledBack = false;
      const prepareAndWrite = async () => {
        staged = await (kind === "file" ? stageFileTransaction : stageSectionTransaction)(JSON.stringify(body), roots, id);
        livePaths = live ? [...new Set(staged.targets.filter((target) => inside(target.path, live.root))
          .map((target) => relativeWithinRoot(target.path, live.root)))] : [];
        await transactionJournal.append({ id, kind: "editor", state: "prepared", preparedAt: new Date().toISOString(), targets: staged.targets });
        const written = await staged.commit();
        response = kind === "file" ? await staged.response() : { ok: true, written, skipped: staged.skipped };
      };
      const rollback = async () => {
        if (staged) await staged.rollback();
        rolledBack = true;
      };
      try {
        if (needsLive) {
          const result = await git.commitPathsWithMutation(live.root, () => livePaths, "chore(contextcake): save editor changes", {
            mutate: prepareAndWrite, rollback, author: live.profileName, skipIfClean: true,
          });
          committed = result.committed === true;
        } else {
          await prepareAndWrite();
        }
        await transactionJournal.append({ id, state: "committed", committedAt: new Date().toISOString() });
      } catch (error) {
        if (error.code === "LockBusy") throw new ControlError("LIVE_LAYER_BUSY", error.message.includes("manual cleanup") ? error.message : "Nothing was changed. The team layer is busy. Try again in a moment.", { status: 409 });
        if (!staged) throw error;
        try {
          if (["RecoveryRequired", "RollbackFailed"].includes(error.code)) throw error;
          if (committed) {
            // A commit followed by journal failure must be undone with a
            // second locked commit, so the next push cannot revive the edit.
            await git.commitPathsWithMutation(live.root, livePaths, `chore(contextcake): roll back editor transaction ${id}`, {
              mutate: rollback, rollback: async () => {}, author: live.profileName, skipIfClean: true,
            });
          } else if (!rolledBack) await rollback();
          await transactionJournal.append({ id, state: "rolled_back", rolledBackAt: new Date().toISOString() });
          await staged.cleanup();
        } catch (rollbackError) {
          // Keep backups for the existing startup recovery path.
          throw new ControlError("RECOVERY_REQUIRED", `Editor recovery is required: ${rollbackError.message}`);
        }
        throw error;
      }
      await staged.cleanup();
      onWritten(staged.targets.map((target) => target.path));
      return { response, live, livePaths, committed };
    });
    // Network work never holds the manifest lease. A failed push leaves the
    // local commit available for the ordinary source Sync path.
    if (outcome.livePaths.length) {
      let pushed = { pushed: false, queued: false };
      if (outcome.committed) {
        try { pushed = await git.push(outcome.live.root); }
        catch { pushed = { pushed: false, queued: true }; }
      }
      outcome.response.git = { layer: outcome.live.name, paths: outcome.livePaths, committed: outcome.committed, ...pushed };
    }
    return outcome.response;
  }

  return { writeFile: (body) => save("file", body), writeSection: (body) => save("section", body) };
}
