// Proves the engine cannot freeze the UI, and does not freeze itself.
//
// The setup "Resolving…" hang happened because the engine shared an event loop
// with the window: walking folders, parsing markdown and running the tokenizer
// all blocked the thread that draws. The engine now runs in its own
// utilityProcess, and this test measures the difference rather than assuming
// it — it points the app at a deliberately large corpus and watches the MAIN
// process's timer lag while that corpus is being read.
//
// Isolation cuts both ways, and the second half was untested until the engine
// watchdog went in: moving the work off the UI thread means a stall in the
// ENGINE's request path no longer shows up as main-loop lag at all. It shows up
// as an app where nothing about sources ever finishes, with a perfectly
// responsive window. So this also measures the engine's own HTTP round trip
// while the same index runs, and fails if answers stop arriving promptly.
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

// The engine's own budget, sampled every ~20ms for 1.2s of the same index.
//
// Measured on an M-series Mac, three consecutive runs at DOCS=2500:
//   p50 2ms / p95 3ms / max 38ms   (50 probes, 0 failures)
//   p50 2ms / p95 3ms / max 29ms   (50 probes, 0 failures)
//   p50 2ms / p95 3ms / max 15ms   (53 probes, 0 failures)
//
// The ceilings are the plan's API-responsiveness SLO (p95 < 50ms, max < 250ms),
// which sits at ~17x and ~6.5x that headroom — loose enough for a loaded CI
// runner, tight enough that a synchronous stretch in the engine's request path
// fails immediately. Verified by putting one there: a 300ms busy-wait per
// request took p95 to 306ms and the suite went red naming the engine.
const MAX_ENGINE_P95_MS = 50
const MAX_ENGINE_MAX_MS = 250
// Only guards "the probe loop ran at all" — a window that never opened, or a
// loop that threw on its first iteration. It deliberately sits far below the
// ~50 a healthy run produces, because a SLOW engine yields few probes by
// construction (the window is fixed at 1.2s, so probes ≈ 1200/(latency+gap)):
// a bar set for statistical density would fire on every latency above ~40ms and
// make the ceilings below unreachable. Slowness is the latency assertion's job.
const MIN_ENGINE_PROBES = 3

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

  const match = out.match(
    /SMOKE OK .*lag=(\d+)ms indexing=(true|false) engineP50=(\d+)ms engineP95=(\d+)ms engineMax=(\d+)ms engineProbes=(\d+) engineFailures=(\d+)/,
  )
  if (code !== 0 || !match) {
    process.stdout.write(`ISOLATION FAIL: code=${code}\n--- output ---\n${out}\n`)
    process.exitCode = 1
    return
  }

  const lag = Number(match[1])
  const wasIndexing = match[2] === 'true'
  const engine = {
    p50: Number(match[3]), p95: Number(match[4]), max: Number(match[5]),
    probes: Number(match[6]), failures: Number(match[7]),
  }

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

  // A number nobody sampled is not a measurement. The window is 1.2s of ~20ms
  // probes, so anything near zero means the probe loop, not the engine, broke.
  if (engine.probes < MIN_ENGINE_PROBES) {
    process.stdout.write(
      `ISOLATION FAIL: only ${engine.probes} engine probes landed (expected at least ${MIN_ENGINE_PROBES}); `
      + 'the latency numbers below describe nothing.\n',
    )
    process.exitCode = 1
    return
  }

  if (engine.failures > 0) {
    process.stdout.write(
      `ISOLATION FAIL: ${engine.failures} of ${engine.probes} GET /api/status probes did not answer `
      + `while the engine indexed ${DOCS} documents.\n`,
    )
    process.exitCode = 1
    return
  }

  if (engine.p95 > MAX_ENGINE_P95_MS || engine.max > MAX_ENGINE_MAX_MS) {
    process.stdout.write(
      `ISOLATION FAIL: the engine answered GET /api/status in p95 ${engine.p95}ms / max ${engine.max}ms `
      + `over ${engine.probes} probes while indexing ${DOCS} documents `
      + `(limits ${MAX_ENGINE_P95_MS}ms / ${MAX_ENGINE_MAX_MS}ms). `
      + `Main-process lag was ${lag}ms, so the stall is inside the engine's request path, not the UI thread.\n`,
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `ISOLATION OK: main process lag ${lag}ms while the engine indexed ${DOCS} documents `
    + `(limit ${MAX_LAG_MS}ms); engine GET /api/status p50 ${engine.p50}ms p95 ${engine.p95}ms `
    + `max ${engine.max}ms over ${engine.probes} probes (limits ${MAX_ENGINE_P95_MS}ms / ${MAX_ENGINE_MAX_MS}ms)\n`,
  )
  process.exitCode = 0
})
