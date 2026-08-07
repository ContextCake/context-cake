// App preferences: a small JSON file in the config dir. Preferences only —
// never credentials (those live in the keychain via safeStorage) and never
// knowledge content.
//
// Writes are asynchronous and serialized. They used to be a synchronous
// write-then-rename on the main process, and the sidebar resizer drives a
// ui-state patch per `pointermove` — 60–120 write+rename cycles a second on the
// thread that draws. The console debounces its end of that; this side stops the
// remaining writes from touching the UI thread at all.
//
// `readSettings` stays synchronous on purpose: fifteen callers are synchronous
// by contract (window construction, renderer argv, the menu, the updater), and
// a tiny JSON read is not what stalled anything. What it must NOT do is read a
// file whose newest contents are still in the write queue — see `unflushed`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { settingsPath } from './paths.mjs'

const DEFAULTS = Object.freeze({
  theme: 'system',
  density: 'comfortable',
  // Spec (distribution §5): the update check is disable-able.
  updateCheck: true,
  // null = follow this Mac's Accessibility "Reduce transparency" setting.
  // A boolean is an explicit choice made in Settings and outranks the OS.
  reducedTransparency: null,
})

/**
 * The newest settings this process has produced but has not yet flushed to
 * disk, or null when the disk is caught up. `readSettings` prefers it, which is
 * what keeps two patches issued in the same tick from each reading the
 * pre-patch file and dropping the other's field — the exact hazard of moving
 * the write off the synchronous path.
 */
let unflushed = null
/** Resolves when every queued write has been attempted. Never rejects. */
let queue = Promise.resolve()
let lastWriteError = null
/** Distinct temp names so an in-flight async write and a quit-time sync write
 *  can never write the same scratch file at once. */
let tempCounter = 0

export function readSettings() {
  if (unflushed) return { ...DEFAULTS, ...unflushed }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function drain() {
  const value = unflushed
  if (!value) return
  const file = settingsPath()
  const temporary = `${file}.${(tempCounter += 1)}.tmp`
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(temporary, serialize(value), { mode: 0o600 })
    await fsp.rename(temporary, file)
    lastWriteError = null
  } catch (err) {
    lastWriteError = err
    await fsp.rm(temporary, { force: true }).catch(() => {})
  } finally {
    // Only the newest state clears the marker: a patch that landed while this
    // write was in flight owes its own pass, and reads must keep seeing it.
    if (unflushed === value) unflushed = null
  }
}

function schedule() {
  queue = queue.then(drain, drain)
  return queue
}

function persistSettings(patch, changedFields) {
  const current = readSettings()
  // The manifest remains the one authoritative local copy of source configs.
  // Never duplicate paths, commands, or credential references into settings.json.
  const { sources: _sources, profiles: _profiles, ...diskPatch } = patch
  const { sources: _currentSources, profiles: _currentProfiles, ...diskCurrent } = current
  const next = {
    ...diskCurrent,
    ...diskPatch,
  }
  if (changedFields.length > 0) {
    const dirtyFields = [...new Set([...(current._sync?.dirtyFields ?? []), ...changedFields])]
    next._sync = { ...(current._sync ?? {}), dirty: true, dirtyFields, localUpdatedAt: new Date().toISOString() }
  }
  unflushed = next
  schedule()
  return next
}

export function writeSettings(patch) {
  return persistSettings(patch, Object.keys(patch))
}

/** Persist a device-local preference without adding it to account sync state. */
export function writeLocalSettings(patch) {
  return persistSettings(patch, [])
}

export function markSettingsDirty(fields) {
  return persistSettings({}, fields)
}

/**
 * Wait for the disk to catch up. Resolves false if the last write failed, so a
 * caller that has to know (the metrics opt-in, which must not report without a
 * persisted choice) can still find out. Never rejects — a failed preference
 * write is not worth an unhandled rejection on the main process.
 *
 * Anything that hands settings.json to another writer (`settings-sync` reads
 * and rewrites the same file) must await this first, or it will read a copy
 * that is one patch behind and write the older values back.
 */
export function flushSettings() {
  return queue.then(() => lastWriteError === null)
}

/**
 * Land any pending write synchronously. For exit paths only: `app.exit()` does
 * not wait for the microtask queue, so without this a window position saved on
 * close would be lost on the way out.
 */
export function flushSettingsSync() {
  const value = unflushed
  if (!value) return
  unflushed = null
  const file = settingsPath()
  const temporary = `${file}.${(tempCounter += 1)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, serialize(value), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } catch {
    // The app is on its way out; a lost preference beats a failed shutdown.
    try { fs.rmSync(temporary, { force: true }) } catch { /* nothing to clean */ }
  }
}
