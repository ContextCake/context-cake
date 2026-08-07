// What happens around an engine relaunch, driven through the real app.
//
// A relaunch is the one moment the app has live windows and no engine, and
// three separate things went wrong in that window: a quit arriving mid-boot
// leaked the engine it had just forked (and with it every MCP server that
// engine had spawned), a renderer-initiated navigation dereferenced the null
// handle straight into the fatal exit handler, and a relaunch that failed
// called handleFatal — showing boot-failure copy after a successful boot and
// quitting, which is the one thing its own prompt promises will not happen.
//
// None of this is testable without Electron and the utility process: the
// assertions are about their real timing. The app does the checking under
// CC_SMOKE_ENGINE_LIFECYCLE=1 (see smokeCheck in src/main/main.mjs) because
// only it can hold references to `service` and `win`; this drives it and reads
// the verdict.
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

test('a relaunch survives a teardown, a null-engine navigation, and its own failure', async () => {
  // The basename has to stay "ContextCake" — the app asserts it, because the
  // CLI resolves the same directory by name.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lifecycle-'))
  const userData = path.join(home, 'ContextCake')
  fs.mkdirSync(userData, { recursive: true })

  const { code, out } = await new Promise((resolve) => {
    const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CC_SMOKE: '1', CC_SMOKE_ENGINE_LIFECYCLE: '1' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      fs.rmSync(home, { recursive: true, force: true })
      resolve({ code: exitCode, out })
    })
  })

  assert.match(out, /ENGINE LIFECYCLE OK/, `engine lifecycle checks did not pass\n${out}`)
  // A failed relaunch taking the fatal path is the loudest form of the bug:
  // the app exits before it can report anything at all.
  assert.doesNotMatch(out, /\[contextcake\] fatal:/, `something took the fatal-exit path\n${out}`)
  assert.equal(code, 0, `the app did not exit cleanly\n${out}`)
})
