// Profile selection for read commands. ctx.selectProfile() reads the manifest
// strictly, which is right for writes; a read reads around one invalid layer
// the way the service does (manifest.mjs readContextManifestQuarantined), so
// a single hand-edited layer does not take `concept search` down with it. The
// skipped layer shows up in coverage and as a warning.
//
// Returns { selection, manifest, quarantined }: hand `manifest` and
// `quarantined` to the operation so it answers from the manifest the envelope
// describes, not a second read of the file.

import fs from "node:fs";
import { readContextManifestQuarantined, selectManifestProfile } from "../manifest.mjs";
import { manifestControlError } from "../control/errors.mjs";
import { manifestRevisionOf } from "./context.mjs";

export function selectProfileForRead(ctx) {
  try {
    const selection = ctx.selectProfile();
    return { selection, manifest: ctx.readManifest(), quarantined: [] };
  } catch (error) {
    if (error?.code !== "MANIFEST_INVALID") throw error;
    let raw;
    let read;
    try {
      raw = JSON.parse(fs.readFileSync(ctx.manifestPath, "utf8"));
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
      manifestRevision: manifestRevisionOf(raw),
      profileId: selection.profileId,
      profileReason: selection.reason,
    });
    for (const warning of selection.warnings) {
      if (warning.code !== "pending-source") ctx.warn(warning.code, warning.message ?? warning.code, warning);
    }
    const quarantined = read.quarantined.filter((row) => row.profileId === selection.profileId);
    for (const entry of quarantined) {
      ctx.warn("LAYER_QUARANTINED", `Skipped invalid layer ${entry.name}: ${entry.error}`, { layer: entry.name, profileId: entry.profileId });
    }
    return { selection, manifest: read.manifest, quarantined };
  }
}
