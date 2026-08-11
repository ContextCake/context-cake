// settings.mjs writes asynchronously through a queue. These cover the two
// things that change buys and the one thing it must not break: no synchronous
// disk work per patch, patches that arrive in the same tick keep every field,
// and nothing is lost on the way out.
//
// `settings.mjs` reaches `app.getPath('userData')` through paths.mjs, so the
// module graph is loaded behind a resolve hook that answers `electron` with a
// stub. That is also why it is imported dynamically rather than at the top.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'))
process.env.CC_TEST_USER_DATA = userData
process.env.CC_TEST_ELECTRON_STUB = pathToFileURL(path.join(here, 'fixtures', 'electron-stub.mjs')).href
register(pathToFileURL(path.join(here, 'fixtures', 'electron-resolver.mjs')).href)

const settings = await import(pathToFileURL(path.join(here, '..', 'src', 'main', 'settings.mjs')).href)
const settingsFile = path.join(userData, 'settings.json')

const readFile = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

test.after(() => { fs.rmSync(userData, { recursive: true, force: true }) })

test('a patch is readable immediately and reaches disk asynchronously', async () => {
  settings.writeLocalSettings({ density: 'compact' })
  assert.equal(settings.readSettings().density, 'compact')
  assert.equal(fs.existsSync(settingsFile), false, 'the write must not be synchronous')
  assert.equal(await settings.flushSettings(), true)
  assert.equal(readFile().density, 'compact')
})

test('patches in one tick keep every field and cost one write', async () => {
  // The hazard of moving the write off the synchronous path: each patch reads
  // the current settings first, and a read that saw the file rather than the
  // queued state would drop whatever the previous patch had just set.
  settings.writeLocalSettings({ theme: 'dark' })
  settings.writeLocalSettings({ updateCheck: false })
  settings.writeSettings({ density: 'comfortable' })
  await settings.flushSettings()
  const written = readFile()
  assert.equal(written.theme, 'dark')
  assert.equal(written.updateCheck, false)
  assert.equal(written.density, 'comfortable')
  // Only the account-synced write marks the file dirty.
  assert.deepEqual(written._sync.dirtyFields, ['density'])
})

test('flushSettingsSync lands a pending write for an exit that cannot await', async () => {
  await settings.flushSettings()
  settings.writeLocalSettings({ theme: 'light' })
  settings.flushSettingsSync()
  assert.equal(readFile().theme, 'light')
  // And the queued pass that was already scheduled finds nothing left to do.
  await settings.flushSettings()
  assert.equal(readFile().theme, 'light')
})

test('a device-local write bumps the sync revision without marking anything dirty', async () => {
  await settings.flushSettings()
  const before = readFile()._sync ?? {}
  settings.writeLocalSettings({ uiState: { lastView: 'files' } })
  await settings.flushSettings()
  const after = readFile()._sync
  // settings-sync compares this to notice a local change made during its ~15s
  // round trip. `dirty`/`localUpdatedAt` cannot serve for that: a device-local
  // write deliberately never touches them, which is why a uiState (or window
  // geometry, or reduced-transparency) change made during a pull was reverted
  // with nothing anywhere detecting it.
  assert.equal(after.revision, (before.revision ?? 0) + 1)
  assert.deepEqual(after.dirtyFields, before.dirtyFields ?? [])
  assert.equal(after.localUpdatedAt, before.localUpdatedAt)
})

test('a write that cannot reach disk is reported, retained, and retried', async (t) => {
  await settings.flushSettings()
  t.after(() => { process.env.CC_TEST_USER_DATA = userData })
  // A config dir that cannot be created. The real-world shapes of this are a
  // full disk and a read-only ~/Library/Application Support.
  const blocker = path.join(userData, 'not-a-directory')
  fs.writeFileSync(blocker, 'this is a file, so mkdir -p under it fails\n')
  process.env.CC_TEST_USER_DATA = path.join(blocker, 'ContextCake')

  const failed = settings.writeLocalSettings({ density: 'compact' })
  assert.equal(await settings.flushSettings(), false)
  // The change must still be what this process reads. Discarding it is what
  // made the very next readSettings() answer with the stale file — the user's
  // preference gone, reported as saved, with nothing left to retry.
  assert.equal(settings.readSettings().density, 'compact')
  assert.deepEqual(
    await failed.written.then(({ ok }) => ok),
    false,
    'a write that failed must say so to the caller that made it',
  )
  assert.ok((await failed.written).error instanceof Error)

  // And it is owed, not lost: the next write carries it to disk.
  process.env.CC_TEST_USER_DATA = userData
  const recovery = settings.writeLocalSettings({ theme: 'dark' })
  assert.deepEqual(await recovery.written, { ok: true })
  assert.equal(readFile().density, 'compact', 'a failed write must be retried, not discarded')
  assert.equal(readFile().theme, 'dark')
})

test('flushSettingsSync reports a write it could not land, and keeps it', async (t) => {
  await settings.flushSettings()
  t.after(() => { process.env.CC_TEST_USER_DATA = userData })
  const blocker = path.join(userData, 'also-not-a-directory')
  fs.writeFileSync(blocker, 'this is a file too\n')

  settings.writeLocalSettings({ theme: 'light' })
  process.env.CC_TEST_USER_DATA = path.join(blocker, 'ContextCake')
  const landed = settings.flushSettingsSync()
  assert.equal(
    settings.readSettings().theme,
    'light',
    'an exit-path write that failed must not erase the value on its way out',
  )
  assert.equal(landed, false, 'flushSettingsSync must say whether it landed')

  process.env.CC_TEST_USER_DATA = userData
  assert.equal(settings.flushSettingsSync(), true)
  assert.equal(readFile().theme, 'light')
})

test('resetSettings replaces the file with defaults instead of merging over it', async () => {
  await settings.flushSettings()
  settings.writeSettings({ theme: 'dark', density: 'compact' })
  settings.writeLocalSettings({ uiState: { lastView: 'files' }, anonymousMetrics: true })
  await settings.flushSettings()
  const before = readFile()

  const { written } = settings.resetSettings()
  // Readable immediately, like any queued write.
  const now = settings.readSettings()
  assert.equal(now.theme, 'system')
  assert.equal(now.density, 'comfortable')
  assert.deepEqual(await written, { ok: true })

  const after = readFile()
  // A replacement, not a patch: keys outside DEFAULTS are gone, not inherited.
  assert.equal(Object.hasOwn(after, 'uiState'), false, 'uiState must not survive a reset')
  assert.equal(Object.hasOwn(after, 'anonymousMetrics'), false, 'the metrics choice must not survive a reset')
  assert.equal(Object.hasOwn(after, 'theme'), false, 'defaults are derived at read time, not stored')
  // Sync bookkeeping survives with the synced preferences marked dirty, so an
  // account would learn about the reset rather than restoring the old values.
  assert.equal(after._sync.revision, before._sync.revision + 1)
  assert.equal(after._sync.dirty, true)
  for (const field of ['theme', 'density', 'updateCheck']) {
    assert.ok(after._sync.dirtyFields.includes(field), `${field} must be marked dirty`)
  }
})

test('reducedTransparency defaults to null — the OS setting decides', () => {
  assert.equal(Object.hasOwn(settings.readSettings(), 'reducedTransparency'), true)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-empty-'))
  try {
    process.env.CC_TEST_USER_DATA = fresh
    assert.equal(settings.readSettings().reducedTransparency, null)
  } finally {
    process.env.CC_TEST_USER_DATA = userData
    fs.rmSync(fresh, { recursive: true, force: true })
  }
})
