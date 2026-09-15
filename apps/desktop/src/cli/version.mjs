import fs from 'node:fs'
import path from 'node:path'

export function cliVersionCandidates(here) {
  return [
    // Dev checkout: apps/desktop/src/cli -> apps/desktop/package.json.
    path.resolve(here, '..', '..', 'package.json'),
    // Packaged app: Resources/engine/cli -> Resources/app.asar/package.json.
    // Electron's Node runtime exposes files inside app.asar through fs.
    path.resolve(here, '..', '..', 'app.asar', 'package.json'),
  ]
}

export function readCliVersion(here, readFileSync = fs.readFileSync) {
  for (const candidate of cliVersionCandidates(here)) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
    } catch {
      // Try the other supported layout before reporting an unknown version.
    }
  }
  return 'unknown'
}
