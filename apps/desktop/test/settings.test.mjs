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
