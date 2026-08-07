// Window geometry must survive every path that ends the app.
//
// This drives the real Electron binary because the bug was an ordering fact
// about Electron itself, not about our code read in isolation: `before-quit`
// fires BEFORE the window's own `close`. On ⌘Q the quit handler therefore
// cancelled the pending bounds save and flushed an empty queue, and only
// afterwards did `close` compute the geometry — into an asynchronous write
// queue that the exiting process never drained. Resize-then-⌘Q lost the new
// frame every time. The red-X path happens to work because there the order is
// reversed (`close` → `window-all-closed` → `app.quit()` → `before-quit`), so
// both are asserted here: one is the regression, the other is the behaviour
// that must not break while fixing it.
//
// The app runs under CC_SMOKE=1 with its own --user-data-dir, so this never
// touches the developer's real settings.json and never shows a dialog.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron') // resolves to the electron binary path
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUN_TIMEOUT_MS = 90_000

/**
 * Boot the app, move the window, end it the requested way, and report what
 * reached settings.json. `mode` is 'quit' (⌘Q — app.quit() with the window
 * open) or 'close' (the red X).
 */
function runQuitSmoke(mode) {
  // The basename has to stay "ContextCake": the app asserts it, because the
  // CLI resolves the same directory by name.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-quit-'))
  const userData = path.join(home, 'ContextCake')
  fs.mkdirSync(userData, { recursive: true })

  return new Promise((resolve) => {
    const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CC_SMOKE: '1', CC_SMOKE_QUIT: mode },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      let settings = null
      try {
        settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
      } catch { /* never written — that is the failure this test reports */ }
      fs.rmSync(home, { recursive: true, force: true })
      const reported = /QUIT SMOKE bounds=(\{[^\n]*?\}) /.exec(out)
      resolve({ code, out, settings, reported: reported ? JSON.parse(reported[1]) : null })
    })
  })
}

function assertGeometryPersisted(run, label) {
  assert.ok(run.reported, `${label}: the app never reported its frame\n${run.out}`)
  assert.equal(run.reported.width, 1024, `${label}: setBounds did not take effect\n${run.out}`)
  assert.ok(
    run.settings?.mainWindow?.bounds,
    `${label}: no window geometry reached settings.json\n${run.out}`,
  )
  assert.deepEqual(
    run.settings.mainWindow.bounds,
    run.reported,
    `${label}: the geometry on disk is not the frame the window had at exit\n${run.out}`,
  )
  assert.equal(run.settings.mainWindow.maximized, false, label)
}

test('⌘Q after a resize saves the window frame', async () => {
  const run = await runQuitSmoke('quit')
  assert.match(run.out, /QUIT SMOKE .* pendingSave=true/, `the debounced save must still be pending\n${run.out}`)
  assertGeometryPersisted(run, 'app.quit()')
})

test('closing the window after a resize saves the window frame', async () => {
  const run = await runQuitSmoke('close')
  assertGeometryPersisted(run, 'window close')
})
