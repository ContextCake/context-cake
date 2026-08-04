// Sequencing for the anonymous-metrics consent prompt. No Electron imports —
// this module is exercised directly by `node --test`. The dialog itself lives
// in main.mjs; this module owns the decision of WHEN it may appear: never
// before the user has configured at least one source layer, so a fresh
// install's first minutes belong to setup, not a permissions question.

/**
 * Count the layers a manifest configures across every shape the app can meet:
 * legacy ({ layers }), transitional ({ layers, profiles }) and profiles-v2
 * ({ profiles: { id: { layers } } }). Tolerant of malformed content — the
 * manifest is a user-editable file and this feeds a consent decision, never an
 * error path.
 */
export function manifestLayerCount(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return 0
  let count = Array.isArray(manifest.layers) ? manifest.layers.length : 0
  const profiles = manifest.profiles
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    for (const profile of Object.values(profiles)) {
      if (profile && typeof profile === 'object' && !Array.isArray(profile) && Array.isArray(profile.layers)) {
        count += profile.layers.length
      }
    }
  }
  return count
}

/**
 * Whether the first-run consent prompt should wait for the first layer.
 * True only when the user has never answered (no stored boolean) AND no source
 * layer exists yet — a fresh install mid-setup. With a stored answer there is
 * nothing to ask; with layers already present (an upgrade, or a skipped wizard
 * revisited on a later launch) the prompt belongs at boot exactly as before.
 */
export function shouldDeferConsentPrompt({ storedPreference, manifest }) {
  if (typeof storedPreference === 'boolean') return false
  return manifestLayerCount(manifest) === 0
}
