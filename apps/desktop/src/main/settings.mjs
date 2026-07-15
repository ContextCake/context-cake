// App preferences: a small JSON file in the config dir. Preferences only —
// never credentials (those live in the keychain via safeStorage) and never
// knowledge content.
import fs from 'node:fs'
import path from 'node:path'
import { settingsPath } from './paths.mjs'

const DEFAULTS = Object.freeze({
  // Spec (distribution §5): the update check is disable-able.
  updateCheck: true,
})

export function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function persistSettings(patch, changedFields) {
  const current = readSettings()
  const dirtyFields = [...new Set([...(current._sync?.dirtyFields ?? []), ...changedFields])]
  // The manifest remains the one authoritative local copy of source configs.
  // Never duplicate paths, commands, or credential references into settings.json.
  const { sources: _sources, profiles: _profiles, ...diskPatch } = patch
  const { sources: _currentSources, profiles: _currentProfiles, ...diskCurrent } = current
  const next = {
    ...diskCurrent,
    ...diskPatch,
    _sync: { ...(current._sync ?? {}), dirty: true, dirtyFields, localUpdatedAt: new Date().toISOString() },
  }
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
  return next
}

export function writeSettings(patch) {
  return persistSettings(patch, Object.keys(patch))
}

export function markSettingsDirty(fields) {
  return persistSettings({}, fields)
}
