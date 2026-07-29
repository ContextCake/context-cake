// Immutable per-process Project Profile context.
//
// Runtime callers select exactly once before opening adapters. They receive a
// flat runtime manifest containing only the selected layers plus the global
// engine settings; the complete manifest stays here for configuration and
// binding revalidation only.

import path from "node:path";
import {
  manifestRevision,
  readContextManifest,
  selectManifestProfile,
  sourceConfigFingerprint,
  withManifestLockAsync,
} from "./manifest.mjs";
import { buildSources } from "./sources/index.mjs";
import { resolveLiveLayer } from "./sources/git-sync.mjs";

export function loadProfileRuntime(manifestPath, {
  requestedProfile = null,
  cwd = process.cwd(),
  realpath,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifestPath);
  // Selection performs profile-scoped Pack validation so drift in an inactive
  // profile is a warning rather than a reason to open or block this stack.
  const manifest = readContextManifest(resolvedManifestPath, { allowMissing: false, validatePacks: false });
  const selection = selectManifestProfile(manifest, {
    requestedProfile,
    cwd,
    ...(realpath ? { realpath } : {}),
  });
  const revision = manifestRevision(manifest);
  const runtimeManifest = {
    layers: selection.layers,
    ...(manifest.settings ? { settings: manifest.settings } : {}),
  };
  return {
    manifestPath: resolvedManifestPath,
    manifestDir,
    selection: Object.freeze({ ...selection, layers: Object.freeze([...selection.layers]) }),
    revision,
    runtimeManifest,
  };
}

export function buildProfileSources(runtime, options = {}) {
  return buildSources(runtime.runtimeManifest, runtime.manifestDir, {
    ...options,
    profileId: runtime.selection.profileId,
  });
}

export function resolveProfileLiveLayer(runtime) {
  const liveLayer = resolveLiveLayer(runtime.selection.layers, runtime.manifestDir);
  if (!liveLayer) return { liveLayer: null, binding: null };
  return {
    liveLayer,
    binding: Object.freeze({
      profileId: runtime.selection.profileId,
      manifestRevision: runtime.revision,
      liveLayerFingerprint: sourceConfigFingerprint(
        runtime.selection.profileId,
        liveLayer.layer,
        runtime.manifestDir,
      ),
    }),
  };
}

// Re-select the process-bound profile explicitly. A changed project mapping
// cannot redirect an already-running MCP process, while deletion, invalidation,
// or any manifest revision/live-layer change fails the pending write closed.
export function revalidateProfileLiveBinding(runtime, expectedBinding) {
  const current = loadProfileRuntime(runtime.manifestPath, {
    requestedProfile: runtime.selection.profileId,
    cwd: runtime.selection.matchedProjectRoot ?? process.cwd(),
  });
  const { binding } = resolveProfileLiveLayer(current);
  if (!binding) throw new Error(`Profile ${expectedBinding.profileId} no longer has a live layer.`);
  if (!sameProfileBinding(expectedBinding, binding)) {
    throw new Error("The selected profile or live-layer configuration changed after staging. Stage the write again in a new session.");
  }
  return binding;
}

export function withProfileLiveBinding(runtime, expectedBinding, mutate) {
  if (typeof mutate !== "function") throw new Error("A profile-bound mutation callback is required.");
  return withManifestLockAsync(runtime.manifestPath, async () => {
    const binding = revalidateProfileLiveBinding(runtime, expectedBinding);
    return mutate(binding);
  });
}

export function sameProfileBinding(left, right) {
  return Boolean(left && right)
    && left.profileId === right.profileId
    && left.manifestRevision === right.manifestRevision
    && left.liveLayerFingerprint === right.liveLayerFingerprint;
}
