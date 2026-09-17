import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { app, autoUpdater, boxes, calls, dialogAnswer, feed, opened, preferences } from './fixtures/updater-stub.mjs'

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

// Only macOS installs updates itself. Every test picks the platform it means,
// so the file passes the same way on a Linux or macOS runner.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const setPlatform = (value) => Object.defineProperty(process, 'platform', { ...realPlatform, value })
setPlatform('darwin')

const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-updater-'))
const originalResources = process.resourcesPath
process.resourcesPath = resources
const updater = await import('../src/main/updater.mjs')
test.after(() => {
  app.emit('before-quit')
  process.resourcesPath = originalResources
  Object.defineProperty(process, 'platform', realPlatform)
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

test('a .deb install only checks: no download, no install on quit, and a link to the release', async () => {
  // electron-builder writes package-type into a deb's resources.
  setPlatform('linux')
  fs.writeFileSync(path.join(resources, 'package-type'), 'deb')
  const notifications = []
  updater.registerRendererUpdates((channel, status) => notifications.push(status))
  const before = { ...calls }
  feed.latest = '0.8.0'
  try {
    // A manual check while automatic checks are off must still not download.
    autoUpdater.autoDownload = true
    const checked = await updater.checkForUpdatesFromRenderer()
    assert.equal(autoUpdater.autoDownload, false)
    assert.equal(autoUpdater.autoInstallOnAppQuit, false)
    assert.deepEqual(checked, { state: 'available', version: '0.8.0', url: 'https://github.com/ContextCake/context-cake/releases/tag/app-v0.8.0' })
    assert.ok(notifications.some((status) => status.state === 'available'))
    assert.ok(!notifications.some((status) => status.state === 'downloading'))

    // The scheduled check uses a plain check, never the download-and-notify path.
    preferences.updateCheck = true
    updater.initUpdater()
    assert.equal(calls.background, before.background)
    assert.equal(calls.manual, before.manual + 2)

    // The menu check offers the download page, and opening it installs nothing.
    dialogAnswer.response = 0
    await updater.checkInteractive(null)
    assert.equal(boxes.at(-1).message, 'ContextCake 0.8.0 is available.')
    assert.deepEqual(boxes.at(-1).buttons, ['Open Download Page', 'Later'])
    assert.deepEqual(opened, ['https://github.com/ContextCake/context-cake/releases/tag/app-v0.8.0'])

    // Even a stray downloaded event cannot make Update Now quit and install.
    autoUpdater.emit('update-downloaded', { version: '0.8.0' })
    assert.deepEqual(await updater.installNow(null), { installed: false })
    assert.equal(calls.install, 0)
  } finally {
    app.emit('before-quit')
    dialogAnswer.response = 1
    feed.latest = '0.7.5'
    fs.rmSync(path.join(resources, 'package-type'))
    setPlatform('darwin')
  }

  // Without the marker the same app self-updates again.
  await updater.checkForUpdatesFromRenderer()
  assert.equal(autoUpdater.autoDownload, true)
  assert.equal(autoUpdater.autoInstallOnAppQuit, true)
})

test('every non-macOS build only notifies, whatever package it came from', async () => {
  // An rpm, pacman, or AppImage target must never reach electron-updater's
  // pkexec installers, and neither may a Linux build with no package-type.
  for (const packageType of ['rpm', 'pacman', null]) {
    setPlatform('linux')
    if (packageType) fs.writeFileSync(path.join(resources, 'package-type'), packageType)
    try {
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      await updater.checkForUpdatesFromRenderer()
      assert.equal(autoUpdater.autoDownload, false, `${packageType}: no download`)
      assert.equal(autoUpdater.autoInstallOnAppQuit, false, `${packageType}: no install on quit`)
    } finally {
      setPlatform('darwin')
      fs.rmSync(path.join(resources, 'package-type'), { force: true })
    }
  }
  await updater.checkForUpdatesFromRenderer()
  assert.equal(autoUpdater.autoDownload, true)
})

test('unpackaged development builds remain unsupported even with metadata', async () => {
  app.isPackaged = false
  const before = { ...calls }
  assert.deepEqual(await updater.checkForUpdatesFromRenderer(), { state: 'unsupported', reason: 'development-build' })
  updater.initUpdater()
  assert.deepEqual(calls, before)
})
