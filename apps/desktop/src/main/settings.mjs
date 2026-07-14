// App preferences: a small JSON file in the config dir. Preferences only —
// never credentials (those live in the keychain via safeStorage) and never
// knowledge content.
import fs from 'node:fs'
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

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n')
  return next
}
