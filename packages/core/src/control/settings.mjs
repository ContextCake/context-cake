// Settings control operations — the shared validation and mutation behind
// GET/PATCH /api/settings and the CLI's `settings` family
// (specs/contextcake-control-plane/design.md §1). The read half is shaped
// from the adapter's already-resolved view, so the HTTP service answers from
// its cache and a CLI session from its own read — one shape, two adapters.

import { mutateContextManifest } from "../manifest.mjs";
import { settingOrigins, settingsCatalog, validateSettingsPatch } from "../settings.mjs";
import { ControlError } from "./errors.mjs";
import { revisionPrecondition } from "./profiles.mjs";

// `origins` names the tier (manifest > env > default) each value came from.
export function settingsView({ manifest, settings }) {
  const origins = Object.fromEntries(Object.entries(settingOrigins(manifest)).map(([key, entry]) => [key, entry.origin]));
  return { settings, stored: manifest.settings ?? {}, origins, catalog: settingsCatalog() };
}

export function patchSettings(manifestPath, patch, { expectRevision = null } = {}) {
  let clean;
  try {
    clean = validateSettingsPatch(patch);
  } catch (err) {
    throw new ControlError("SETTINGS_INVALID", err.message, { status: 400 });
  }
  try {
    mutateContextManifest(manifestPath, (manifest) => {
      const next = { ...(manifest.settings ?? {}) };
      for (const key of Object.keys(patch)) {
        if (clean[key] === undefined) delete next[key]; // null = reset to default
        else next[key] = clean[key];
      }
      if (Object.keys(next).length === 0) delete manifest.settings;
      else manifest.settings = next;
    }, { allowMissing: false, allowTransitional: true, precondition: revisionPrecondition(expectRevision) });
  } catch (err) {
    // Settings deliberately stay a STRICT write — an invalid layer is not
    // this operation's to tolerate, and quietly rewriting a manifest read
    // around one is how a hand-edited layer would get dropped without being
    // asked about. But surfacing a layer's validation error as an internal
    // failure tells the user nothing about where to go. Removing the bad
    // source is the repair, and it has a surface of its own.
    if (err instanceof ControlError || err.status) throw err;
    // A missing manifest or a busy lock is not an invalid source.
    if (/^ContextCake manifest does not exist|^Timed out acquiring the ContextCake manifest lock/.test(err.message)) throw err;
    throw new ControlError(
      "MANIFEST_INVALID",
      `Settings were not saved: a source in your manifest is invalid, and saving would rewrite the file around it. Remove it in Sources first — ${err.message}`,
      { status: 409 },
    );
  }
}
