import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { app, autoUpdater, boxes, calls, preferences } from './fixtures/updater-stub.mjs'

const stubUrl = new URL('./fixtures/updater-stub.mjs', import.meta.url).href
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron' || specifier === 'electron-updater' ||
        (specifier === './settings.mjs' && context.parentURL.includes('/updater.mjs'))) {
      return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true }
    }
    return next(specifier, context)
  }
`)}`)

const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-updater-'))
const originalResources = process.resourcesPath
process.resourcesPath = resources
const updater = await import('../src/main/updater.mjs')
test.after(() => {
  app.emit('before-quit')
  process.resourcesPath = originalResources
  fs.rmSync(resources, { recursive: true, force: true })
})

test('local packaged builds without update metadata remain unavailable across every update entry point', async () => {
  const notifications = []
  updater.registerRendererUpdates((channel, status) => notifications.push([channel, status]))
  updater.initUpdater()
  const expected = { state: 'unsupported', reason: 'missing-update-metadata' }
  assert.deepEqual(updater.getUpdateStatus(), expected)
  assert.deepEqual(await updater.checkForUpdatesFromRenderer(), expected)
  await updater.checkInteractive(null)
  assert.equal(boxes.at(-1).message, 'Updates are unavailable in this local build.')
  assert.deepEqual(await updater.installNow(null), { installed: false })
  assert.deepEqual(calls, { background: 0, manual: 0, install: 0 })
  assert.equal(autoUpdater.eventNames().length, 0)
  assert.equal(preferences.updateCheck, true, 'build capability must not change the user preference')
  assert.ok(notifications.every(([channel, status]) => channel === 'updates:status' && status.state === 'unsupported'))
})

test('release metadata enables normal events, scheduled checks, manual checks and update preferences', async () => {
  fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\nowner: ContextCake\nrepo: context-cake\n')
  updater.registerRendererUpdates(() => {})
  assert.equal(updater.getUpdateStatus().state, 'idle')
  updater.initUpdater()
  assert.equal(calls.background, 1)
  assert.equal(autoUpdater.autoDownload, true)
  assert.equal(autoUpdater.autoInstallOnAppQuit, true)
  await updater.checkForUpdatesFromRenderer()
  assert.equal(calls.manual, 1)
  assert.equal(updater.getUpdateStatus().state, 'not-available')
  autoUpdater.emit('error', new Error('Release feed unavailable'))
  assert.deepEqual(updater.getUpdateStatus(), { state: 'error', error: 'Release feed unavailable' })
  preferences.updateCheck = false
  updater.initUpdater()
  assert.equal(calls.background, 1)
  await updater.checkInteractive(null)
  assert.equal(calls.manual, 2, 'manual checks still work when automatic checks are disabled')
  assert.equal(boxes.at(-1).message, "You're up to date.")
})

test('unpackaged development builds remain unsupported even with metadata', async () => {
  app.isPackaged = false
  assert.deepEqual(await updater.checkForUpdatesFromRenderer(), { state: 'unsupported', reason: 'development-build' })
  updater.initUpdater()
  assert.equal(calls.background, 1)
  assert.equal(calls.manual, 2)
})
