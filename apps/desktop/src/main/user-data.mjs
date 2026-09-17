// Where the app keeps its configuration, and what the smoke test expects.
//
// The app and the CLI must read one manifest. On macOS, Electron's default
// userData (~/Library/Application Support/ContextCake, from app.setName) is
// already the engine's config dir. On Linux Electron would pick
// ~/.config/ContextCake, while the engine and the npm CLI use
// $XDG_CONFIG_HOME/contextcake (packages/core/src/platform-paths.mjs), so the
// Linux app pins userData to the engine's answer.
//
// An explicit --user-data-dir always wins: every spawned desktop test passes
// one to stay out of the real config dir, and pinning over it would send those
// tests into the developer's own manifest.
//
// No Electron imports: main.mjs passes the switch value and the engine's
// resolver in, so both decisions are unit-tested on any host.
import fs from 'node:fs'
import path from 'node:path'

/** The directory to pass to app.setPath('userData'), or null to leave Electron's default. */
export function pinnedUserDataDir({ platform, userDataSwitch, resolveConfigDir }) {
  if (platform !== 'linux' || userDataSwitch) return null
  return resolveConfigDir()
}

function samePath(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return false }
}

/**
 * The smoke test's guard on the app/CLI agreement. Returns `{ ok, expected }`
 * for the userData path Electron actually resolved.
 */
export function checkUserDataDir({ actual, platform, userDataSwitch, resolveConfigDir }) {
  if (userDataSwitch) return { ok: samePath(actual, userDataSwitch), expected: userDataSwitch }
  if (platform === 'linux') {
    const expected = resolveConfigDir()
    return { ok: samePath(actual, expected), expected }
  }
  // macOS: app.setName('ContextCake') decides the folder name, and the
  // engine's darwin branch reads the same one.
  return { ok: path.basename(actual) === 'ContextCake', expected: '…/ContextCake' }
}
