// Engine crash recovery, end to end: a real engine dies twice mid-index, the
// app restarts it on the bounded-backoff policy, names the vault as the
// suspect, quarantines it, and the third engine generation survives with the
// suspect parked as an error row. The app never exits for a post-boot engine
// death — that is the invariant this whole path replaces.
//
// Drives the CC_SMOKE_ENGINE_CRASH branch in main.mjs's smokeCheck; the death
// itself is CC_FORCE_ENGINE_EXIT_AFTER_READY in engine-process.mjs, limited
// to the first two generations via the exit-state file.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-crash-test-'))
const userData = path.join(tmp, 'ContextCake')
const logDir = path.join(tmp, 'logs')
fs.mkdirSync(userData, { recursive: true })

// A corpus big enough that indexing is still in flight when the engine dies
// (~1.5s in): the crash breadcrumbs must catch the vault mid-index for the
// quarantine to have a suspect to name.
const vault = path.join(tmp, 'vault')
fs.mkdirSync(vault, { recursive: true })
const para = 'A run book paragraph long enough to give the tokenizer something to chew on for every note in the corpus. '
for (let i = 0; i < 2000; i++) {
  fs.writeFileSync(
    path.join(vault, `note-${i}.md`),
    `# Note ${i}\n\n## Body {#body}\n\n${para.repeat(12 + (i % 9))}`,
  )
}
fs.writeFileSync(path.join(userData, 'manifest.json'), JSON.stringify({
  layers: [{ name: 'vault', level: 3, source: 'files', path: vault }],
}, null, 2))

const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CC_SMOKE: '1',
    CC_SMOKE_ENGINE_CRASH: '1',
    CC_ENGINE_LOG_DIR: logDir,
    CC_FORCE_ENGINE_EXIT_AFTER_READY: '1500',
    CC_FORCE_ENGINE_EXIT_LIMIT: '2',
    CC_FORCE_ENGINE_EXIT_STATE: path.join(tmp, 'exit-state.json'),
  },
})

let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })

const timer = setTimeout(() => {
  process.stdout.write('ENGINE CRASH TEST FAIL: still running after 120s\n')
  process.exitCode = 1
  child.kill('SIGKILL')
}, 120_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  let breadcrumbs = []
  try { breadcrumbs = JSON.parse(fs.readFileSync(path.join(userData, 'engine-crashes.json'), 'utf8')) } catch { /* asserted below */ }
  let engineLogText = ''
  try { engineLogText = fs.readFileSync(path.join(logDir, 'engine.log'), 'utf8') } catch { /* asserted below */ }
  fs.rmSync(tmp, { recursive: true, force: true })

  const okLine = /ENGINE CRASH SMOKE OK restarts=2 breadcrumbs=2 quarantined=vault/.test(out)
  const okBreadcrumbs = breadcrumbs.length === 2
    && breadcrumbs.every((c) => c.code === 87 && Array.isArray(c.indexingSources) && c.indexingSources.includes('vault'))
  const okLog = engineLogText.includes('quarantining source after repeat crash: vault')
    && engineLogText.includes('engine restart 1 scheduled')
    && engineLogText.includes('engine restart 2 scheduled')
  if (code === 0 && okLine && okBreadcrumbs && okLog) {
    process.stdout.write('ENGINE CRASH TEST OK: two bounded restarts, suspect quarantined, third generation survived\n')
    process.exitCode = 0
  } else {
    process.stdout.write(
      `ENGINE CRASH TEST FAIL: code=${code} okLine=${okLine} okBreadcrumbs=${okBreadcrumbs} okLog=${okLog}\n`
      + `--- breadcrumbs ---\n${JSON.stringify(breadcrumbs, null, 2)}\n--- output ---\n${out}\n`,
    )
    process.exitCode = 1
  }
})
