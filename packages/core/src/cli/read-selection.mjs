// Profile selection for read commands. ctx.selectProfile() reads the manifest
// strictly, which is right for writes; a read reads around one invalid layer
// the way the service does (manifest.mjs readContextManifestQuarantined), so
// a single hand-edited layer does not take `concept search` down with it. The
// skipped layer shows up in coverage and as a warning.

import { readContextManifestQuarantined, selectManifestProfile } from "../manifest.mjs";
import { manifestControlError } from "../control/errors.mjs";
import { currentManifestRevision } from "./context.mjs";

export function selectProfileForRead(ctx) {
  try {
    return ctx.selectProfile();
  } catch (error) {
    if (error?.code !== "MANIFEST_INVALID") throw error;
    let read;
    try {
      read = readContextManifestQuarantined(ctx.manifestPath, { allowMissing: false, validatePacks: false });
    } catch {
      throw error;
    }
    let selection;
    try {
      selection = selectManifestProfile(read.manifest, {
        requestedProfile: ctx.flags.profile ?? null,
        cwd: ctx.flags.cwd ? ctx.resolvePath(ctx.flags.cwd) : ctx.cwd,
      });
    } catch (selectError) {
      throw manifestControlError(selectError);
    }
    ctx.setContext({
      manifestRevision: currentManifestRevision(ctx.manifestPath),
      profileId: selection.profileId,
      profileReason: selection.reason,
    });
    for (const warning of selection.warnings) {
      if (warning.code !== "pending-source") ctx.warn(warning.code, warning.message ?? warning.code, warning);
    }
    for (const entry of read.quarantined.filter((row) => row.profileId === selection.profileId)) {
      ctx.warn("LAYER_QUARANTINED", `Skipped invalid layer ${entry.name}: ${entry.error}`, { layer: entry.name, profileId: entry.profileId });
    }
    return selection;
  }
}
