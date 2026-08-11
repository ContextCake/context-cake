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
/**
 * Serial number of the newest patch, and of the newest patch known to have
 * reached disk. A caller asks "did MY change land?", which a shared error flag
 * cannot answer: the next successful write clears it, so a preference that
 * never made it looks saved as soon as anything else is saved.
 */
let issuedSeq = 0
let persistedSeq = 0
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
  const seq = issuedSeq
  let temporary = ''
  try {
    const file = settingsPath()
    temporary = `${file}.${(tempCounter += 1)}.tmp`
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(temporary, serialize(value), { mode: 0o600 })
    await fsp.rename(temporary, file)
    lastWriteError = null
    persistedSeq = seq
    // Only the newest state clears the marker: a patch that landed while this
    // write was in flight owes its own pass, and reads must keep seeing it.
    if (unflushed === value) unflushed = null
  } catch (err) {
    lastWriteError = err
    if (temporary) await fsp.rm(temporary, { force: true }).catch(() => {})
    // `unflushed` deliberately survives a failed write. Clearing it here — as
    // this used to, in a `finally` that could not tell success from failure —
    // meant the very next readSettings() answered with the stale file: the
    // user's change silently gone, nothing left to retry, and the caller told
    // it had been saved. Holding it keeps reads honest, lets the next patch's
    // pass carry it, and gives flushSettingsSync() a last attempt on the way
    // out. There is no timer-driven retry on purpose: the failures that
    // actually happen here are a full disk and a read-only config directory,
    // and neither is fixed by trying again in a second.
  }
}

function schedule() {
  queue = queue.then(drain, drain)
  return queue
}

/**
 * Queue a patch and hand back both the settings it produces and the fate of
 * the write. `written` resolves — never rejects, so a caller that ignores it
 * can't reach the main process's unhandledRejection handler, which is the
 * fatal-exit path.
 *
 * @returns {{settings: object, written: Promise<{ok: boolean, error?: Error}>}}
 */
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
  // Every write bumps the revision, sync-dirty or not. settings-sync compares
  // it to notice a local change made while it was on the network; `dirty` and
  // `localUpdatedAt` cannot serve, because a device-local write deliberately
  // never touches them — so a uiState, window-geometry or transparency change
  // made during a pull was written back over with nothing detecting it.
  next._sync = { ...(current._sync ?? {}), revision: (current._sync?.revision ?? 0) + 1 }
  if (changedFields.length > 0) {
    const dirtyFields = [...new Set([...(current._sync?.dirtyFields ?? []), ...changedFields])]
    next._sync = { ...next._sync, dirty: true, dirtyFields, localUpdatedAt: new Date().toISOString() }
  }
  return queueWrite(next)
}

/** Hand a fully-formed settings object to the write queue. */
function queueWrite(next) {
  unflushed = next
  const seq = (issuedSeq += 1)
  const written = schedule().then(() => (
    persistedSeq >= seq
      ? { ok: true }
      : { ok: false, error: lastWriteError ?? new Error('The settings file could not be written.') }
  ))
  return { settings: next, written }
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
 * Return local preferences to their defaults — a replacement, not a merged
 * patch: uiState and any stale keys go too, which persistSettings (a spread
 * over the current file) cannot express.
 *
 * Three things deliberately survive, because a reset is not what any of them
 * responds to:
 *
 * - `_sync`, with the revision bumped and the account-synced fields marked
 *   dirty, so a signed-in account learns about the reset instead of writing
 *   the old values straight back on the next pull. `ownerUserId` in
 *   particular MUST survive: settings-sync gates the dirty-push on it
 *   matching the session, so dropping it turns the next pull into a merge
 *   that restores exactly what was just reset.
 * - `anonymousMetrics`, a privacy decision rather than a preference. Clearing
 *   it would silently discard a consent answer and re-ask at the next launch
 *   (metrics-consent.mjs prompts on `undefined`), which is not something a
 *   "reset my appearance settings" action should ever cause.
 * - `mainWindow`, the window geometry. The live window writes its bounds back
 *   on close and on quit regardless, so clearing it here would be undone
 *   within seconds — a reset that reports success and visibly does nothing.
 *   Not promising it is honest; the dialog copy says so too.
 */
export function resetSettings() {
  const current = readSettings()
  const next = {
    _sync: {
      ...(current._sync ?? {}),
      revision: (current._sync?.revision ?? 0) + 1,
      dirty: true,
      dirtyFields: [...new Set([...(current._sync?.dirtyFields ?? []), 'theme', 'density', 'updateCheck'])],
      localUpdatedAt: new Date().toISOString(),
    },
  }
  if (typeof current.anonymousMetrics === 'boolean') next.anonymousMetrics = current.anonymousMetrics
  if (current.mainWindow !== undefined) next.mainWindow = current.mainWindow
  return queueWrite(next)
}

/**
 * Wait for the disk to catch up. Resolves false when anything issued before
 * the call is still not on disk, so a caller that has to know can still find
 * out — the metrics opt-in (which must not report without a persisted choice)
 * and every sync path (which must not hand a stale file to a second writer).
 * Never rejects: a failed preference write is not worth an unhandled rejection
 * on the main process, which is the fatal handler.
 *
 * Anything that hands settings.json to another writer (`settings-sync` reads
 * and rewrites the same file) must await this first, or it will read a copy
 * that is one patch behind and write the older values back.
 */
export function flushSettings() {
  const seq = issuedSeq
  return queue.then(() => persistedSeq >= seq)
}

/**
 * Land any pending write synchronously, and say whether it landed. For exit
 * paths only: `app.exit()` does not wait for the microtask queue, so without
 * this a window position saved on close would be lost on the way out.
 *
 * A failure keeps the value rather than dropping it — the process may not be
 * as far gone as the caller thinks (before-quit runs long before exit), and a
 * read in between must not answer with the file this was trying to replace.
 */
export function flushSettingsSync() {
  const value = unflushed
  if (!value) return true
  const seq = issuedSeq
  let temporary = ''
  try {
    const file = settingsPath()
    temporary = `${file}.${(tempCounter += 1)}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, serialize(value), { mode: 0o600 })
    fs.renameSync(temporary, file)
    lastWriteError = null
    persistedSeq = seq
    if (unflushed === value) unflushed = null
    return true
  } catch (err) {
    lastWriteError = err
    // The app is on its way out; a lost preference beats a failed shutdown.
    try { if (temporary) fs.rmSync(temporary, { force: true }) } catch { /* nothing to clean */ }
    return false
  }
}
