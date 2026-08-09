// On macOS, closing the last window must not end the app.
//
// This drives the real Electron binary because the bug was about what the
// platform does, not about code read in isolation: `window-all-closed` called
// `app.quit()` unconditionally, so the red X killed the process — and that in
// turn made the `activate` handler directly above it unreachable, since there
// was never a running app left for the Dock icon to reopen. The two handlers
// encoded contradictory intentions and only one of them could ever win.
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

function runCloseSmoke() {
  // The basename has to stay "ContextCake": the app asserts it, because the
  // CLI resolves the same directory by name.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-close-'))
  const userData = path.join(home, 'ContextCake')
  fs.mkdirSync(userData, { recursive: true })

  return new Promise((resolve) => {
    const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CC_SMOKE: '1', CC_SMOKE_CLOSE_ALIVE: '1' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      fs.rmSync(home, { recursive: true, force: true })
      resolve({ code, out })
    })
  })
}

test('closing the last window leaves the app running on macOS', { skip: process.platform !== 'darwin' && 'macOS-only behaviour' }, async () => {
  const run = await runCloseSmoke()

  // The survival line only prints if the process outlived the close. Before
  // the fix the app quit inside win.close() and this never appeared.
  const survived = /CLOSE SMOKE survived-close windows=(\d+) platform=(\w+)/.exec(run.out)
  assert.ok(survived, `the app did not survive closing its last window\n${run.out}`)
  assert.equal(survived[1], '0', `expected no windows after the close\n${run.out}`)
  assert.equal(survived[2], 'darwin', run.out)

  // And the point of surviving: the Dock-click path can build a window again.
  const reactivated = /CLOSE SMOKE reactivated windows=(\d+)/.exec(run.out)
  assert.ok(reactivated, `the app never reported reactivating\n${run.out}`)
  // Exactly one. Zero means `activate` is unreachable again; two means the
  // rebuild is not serialized, and a second Dock click during a slow engine
  // boot produced a duplicate main window.
  assert.equal(
    reactivated[1],
    '1',
    `activate rebuilt ${reactivated[1]} windows, expected exactly 1\n${run.out}`,
  )

  // Surviving the close is only half of it: the app still has to be able to
  // quit. Without this, an app that outlived its windows and could no longer
  // exit would pass every assertion above — the SIGKILL at RUN_TIMEOUT_MS
  // still produces an `exit` event and the output still holds both lines, so
  // the regression would cost 90 silent seconds instead of failing.
  assert.equal(run.code, 0, `the app did not exit cleanly after reactivating\n${run.out}`)
})
