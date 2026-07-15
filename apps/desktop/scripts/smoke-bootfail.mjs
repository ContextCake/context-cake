// Boot-failure guard: with CC_FORCE_BOOT_FAIL=1 the app must fail FAST with a
// non-zero exit — never hang with no window (the regression that produced the
// "A JavaScript error occurred in the main process" EPIPE crash dialog and,
// under CC_SMOKE in CI, a job that blocks to timeout). Asserts the process
// exits non-zero within a few seconds.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron') // path to the electron binary
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const child = spawn(electron, [appDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CC_SMOKE: '1', CC_FORCE_BOOT_FAIL: '1' },
})

let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const HANG_MS = 15000
const timer = setTimeout(() => {
  process.stdout.write('BOOTFAIL FAIL: still running after 15s (would hang CI)\n')
  process.exitCode = 1
  child.kill('SIGKILL')
}, HANG_MS)

// Set process.exitCode (not process.exit) so stdout drains before we exit —
// an immediate process.exit races the pipe write and loses the verdict.
child.on('exit', (code) => {
  clearTimeout(timer)
  const sawFatal = /\[contextcake\] fatal:/.test(out)
  if (code !== 0 && code != null && sawFatal) {
    process.stdout.write(`BOOTFAIL OK: exited code=${code} with clean fatal log (no hang)\n`)
    process.exitCode = 0
  } else {
    process.stdout.write(`BOOTFAIL FAIL: code=${code} sawFatal=${sawFatal}\n--- output ---\n${out}\n`)
    process.exitCode = 1
  }
})
