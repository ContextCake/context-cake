// Proves the engine cannot freeze the UI.
//
// The setup "Resolving…" hang happened because the engine shared an event loop
// with the window: walking folders, parsing markdown and running the tokenizer
// all blocked the thread that draws. The engine now runs in its own
// utilityProcess, and this test measures the difference rather than assuming
// it — it points the app at a deliberately large corpus and watches the MAIN
// process's timer lag while that corpus is being read.
//
// Boots the real app (CC_SMOKE=1) against a temporary user-data directory, so
// it never touches a developer's actual ContextCake config.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Electron honors Chromium's --user-data-dir for app.getPath('userData'). The
// directory is named ContextCake so the smoke test's app-name assertion (which
// guards `contextcake mcp`) still means something here.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-isolation-'))
const userData = path.join(tmp, 'ContextCake')
const corpus = path.join(tmp, 'corpus')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(corpus, { recursive: true })

const DOCS = 2500
const body = `## Section\n\n${'Enough prose per document that reading the corpus takes real time. '.repeat(40)}`
for (let i = 0; i < DOCS; i += 1) {
  fs.writeFileSync(path.join(corpus, `doc-${i}.md`), `# Doc ${i}\n\n${body}`)
}
fs.writeFileSync(
  path.join(userData, 'manifest.json'),
  `${JSON.stringify({ layers: [{ name: 'corpus', level: 3, source: 'files', path: corpus }] }, null, 2)}\n`,
)

// A main process doing the indexing itself blocks for seconds at a stretch;
// isolated, its timers should barely drift. Generous enough to survive a
// loaded CI runner while still failing loudly if the work moves back onto the
// UI thread.
const MAX_LAG_MS = 400

// Escape hatch for containers/CI images that need extra Chromium switches
// (e.g. CC_ELECTRON_ARGS="--no-sandbox" when running as root). Unset on a
// normal Mac, where the defaults are correct.
const extraArgs = (process.env.CC_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)

const child = spawn(electron, [appDir, `--user-data-dir=${userData}`, ...extraArgs], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CC_SMOKE: '1' },
})

let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })

const timer = setTimeout(() => {
  process.stdout.write('ISOLATION FAIL: app still running after 120s\n')
  process.exitCode = 1
  child.kill('SIGKILL')
}, 120_000)

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

child.on('exit', (code) => {
  clearTimeout(timer)
  cleanup()

  const match = out.match(/SMOKE OK .*lag=(\d+)ms indexing=(true|false)/)
  if (code !== 0 || !match) {
    process.stdout.write(`ISOLATION FAIL: code=${code}\n--- output ---\n${out}\n`)
    process.exitCode = 1
    return
  }

  const lag = Number(match[1])
  const wasIndexing = match[2] === 'true'

  // Without this the lag number proves nothing: the engine has to have been
  // busy during the measurement for a low number to mean isolation.
  if (!wasIndexing) {
    process.stdout.write(
      `ISOLATION FAIL: the engine had already finished indexing ${DOCS} documents, `
      + 'so main-process lag was not measured under load.\n',
    )
    process.exitCode = 1
    return
  }

  if (lag > MAX_LAG_MS) {
    process.stdout.write(
      `ISOLATION FAIL: main process stalled ${lag}ms while the engine indexed `
      + `${DOCS} documents (limit ${MAX_LAG_MS}ms). Engine work is back on the UI thread.\n`,
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `ISOLATION OK: main process lag ${lag}ms while the engine indexed ${DOCS} documents `
    + `(limit ${MAX_LAG_MS}ms)\n`,
  )
  process.exitCode = 0
})
