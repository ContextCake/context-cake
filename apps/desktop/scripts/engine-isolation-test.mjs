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

// ---- the corpus, which is the experiment -----------------------------------
//
// What this replaced was 2,500 documents of ~2.6KB — 6.6MB against a field
// vault of 139MB across ~3,000 notes averaging 47.6KB. Task 0.2 asks for 3,000
// documents at 10–50KB and says why in one line: "small docs hide the CPU-per-
// chunk cost that produces stutter". Size alone turned out to be the smaller
// half of the story.
//
// The engine's per-document synchronous work is parse + `countTokens`, and
// `countTokens` is an exact o200k BPE encode (tokenize.mjs) with no per-piece
// cache. Its cost therefore tracks how many merge steps the text needs, not how
// many bytes it has — and the old fixture was one sentence repeated, whose
// handful of common words are single tokens. Measured directly (ms to encode
// 8MB, on this machine):
//
//   real knowledge-base notes (159 files, the shape a user actually has)  ~220 ms/MB
//   old fixture, one sentence repeated                                      93 ms/MB
//   invented compound words ("extrahyperretrievational")                  ~900 ms/MB
//
// So the old corpus was ~2.3x cheaper per byte than real notes AND 21x smaller,
// and inventing vocabulary to compensate overshoots by 4x. What makes real
// notes expensive is the material real notes are full of: dates, file paths,
// identifiers, hex ids, URLs, code fences, tables. This generator mixes that
// into ordinary Zipf-distributed English at a rate calibrated against the
// measurement above (246 ms/MB here vs ~280 for the real notes in the same
// run) — realistic, and deliberately not harder than reality.
const DOCS = 3_000
const MIN_DOC_BYTES = 10 * 1024
const MAX_DOC_BYTES = 50 * 1024
// Share of words drawn from the expensive pool. Calibrated, not chosen.
const DENSE_WORD_RATE = 0.12

// Deterministic, so two runs on the same machine are comparable and a CI number
// can be argued with rather than shrugged at.
let seed = 20260807
const nextRandom = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = (list) => list[Math.floor(nextRandom() * list.length)]
const WORDS = ('the of and to in a is that for it as was with be by on not this are or from at which but have an they one '
  + 'you had has her all were their we can there so if would about when who will more no other into over than its two '
  + 'time only some could them these may then now such first any our out most also after before between under while '
  + 'retrieval cascade resolver manifest section conflict provenance layer concept index token snapshot adapter walker '
  + 'digest harness budget fixture probe anchor corpus schema policy embedding cursor ledger release migration rollback '
  + 'query ranking recall precision latency throughput cache invalidation watcher directory frontmatter heading document '
  + 'vault repository commit branch review merge threshold measurement regression baseline evidence question answer note '
  + 'meeting decision owner deadline risk mitigation summary context window prompt agent tool call response error retry')
  .split(/\s+/)
const PATHS = ['packages/core/src/service.mjs', 'apps/desktop/src/main/engine-watchdog.mjs', 'src/sources/okf-local.mjs',
  'docs/architecture/README.md', '~/Library/Application Support/ContextCake/manifest.json', 'apps/console/src/store.tsx']
const IDENTS = ['snapshotSource', 'MAX_DOC_BYTES', 'adoptIndexes', 'readContextManifestQuarantined', 'buildGraph',
  'withDocumentDate', 'resolveLiveLayer', 'CONTEXTCAKE_MAX_SCAN_ENTRIES', 'sourceBudgetMs', 'layerRootMap']
// Zipf-ish: common words dominate, exactly as they do in prose.
const commonWord = () => WORDS[Math.floor(WORDS.length * (nextRandom() ** 2))]
const hex = (digits) => Math.floor(nextRandom() * 16 ** digits).toString(16).padStart(digits, '0')
const denseWord = () => {
  const roll = nextRandom()
  if (roll < 0.3) return `\`${pick(IDENTS)}\``
  if (roll < 0.55) return `\`${pick(PATHS)}\``
  if (roll < 0.7) return `2026-0${1 + Math.floor(nextRandom() * 8)}-${10 + Math.floor(nextRandom() * 19)}`
  if (roll < 0.85) return hex(7)
  return `https://github.com/contextcake/engine/pull/${100 + Math.floor(nextRandom() * 900)}`
}
const sentence = () => {
  const words = []
  for (let i = 9 + Math.floor(nextRandom() * 13); i > 0; i -= 1) {
    words.push(nextRandom() < DENSE_WORD_RATE ? denseWord() : commonWord())
  }
  words[0] = words[0][0].toUpperCase() + words[0].slice(1)
  return `${words.join(' ')}. `
}

let corpusBytes = 0
for (let i = 0; i < DOCS; i += 1) {
  const target = MIN_DOC_BYTES + Math.floor(nextRandom() * (MAX_DOC_BYTES - MIN_DOC_BYTES))
  let doc = `---\nid: doc-${i}\ntitle: ${commonWord()} ${commonWord()}\nupdated: 2026-0${1 + (i % 8)}-1${i % 9}\n---\n\n`
    + `# ${commonWord()} ${commonWord()}\n\n`
  for (let section = 0; doc.length < target; section += 1) {
    doc += `## ${commonWord()} ${commonWord()}\n\n`
    for (let p = 0; p < 3; p += 1) doc += `${sentence()}${sentence()}${sentence()}\n\n`
    if (section % 3 === 1) doc += `| ${commonWord()} | ${commonWord()} |\n|---|---|\n| ${denseWord()} | ${commonWord()} |\n\n`
    if (section % 4 === 2) doc += `\`\`\`json\n{"${commonWord()}": "${denseWord()}", "id": "${hex(12)}"}\n\`\`\`\n\n`
  }
  fs.writeFileSync(path.join(corpus, `doc-${i}.md`), doc)
  corpusBytes += doc.length
}

// A fixture too small to gate the bug is how a green gate gets mistaken for a
// working one — the same shape as the churn assertion that passed WITH the bug
// present earlier in this plan, and as this file's own first version. So the
// corpus is checked before anything is measured: shrinking it has to break the
// test loudly rather than quietly make it easier to pass.
const MIN_CORPUS_BYTES = 80 * 1024 * 1024
const avgDocBytes = corpusBytes / DOCS
if (corpusBytes < MIN_CORPUS_BYTES || avgDocBytes < MIN_DOC_BYTES) {
  process.stdout.write(
    `ISOLATION FAIL: the fixture is ${(corpusBytes / 1048576).toFixed(1)}MB across ${DOCS} documents `
    + `(avg ${(avgDocBytes / 1024).toFixed(1)}KB), under the ${MIN_CORPUS_BYTES / 1048576}MB / `
    + `${MIN_DOC_BYTES / 1024}KB-per-document floor the thresholds below were measured against. `
    + 'A corpus this small cannot produce the per-document CPU the SLO is about, so a pass would mean nothing.\n',
  )
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

fs.writeFileSync(
  path.join(userData, 'manifest.json'),
  `${JSON.stringify({ layers: [{ name: 'corpus', level: 3, source: 'files', path: corpus }] }, null, 2)}\n`,
)

// ---- calibrating the ceiling to THIS machine -------------------------------
//
// The latency ceilings below were measured on an M3 Pro, and the first version
// of this file guessed that "a GitHub macos-14 runner is roughly half this
// machine, which puts a healthy p95 there near 20ms". CI then measured p95 65ms
// on a healthy engine and failed the gate. The runner is about six times slower
// on this workload, not two — the guess was wrong in the direction that turns a
// regression gate into a hardware detector.
//
// So measure instead of guessing, and measure the thing that actually varies.
// The engine's per-document synchronous cost is dominated by `countTokens`, an
// exact BPE encode; how fast this machine runs it over this corpus is a direct
// proxy for how fast it can index. Time it on a sample of the fixture we just
// wrote, and scale the ceilings by how far off the reference machine we are.
//
// The floor of 1 matters: a machine at least as fast as the reference is held
// to the plan's actual SLO (p95 < 50ms), so the gate never gets looser than the
// product promise where the promise applies. The cap of 8 matters for the
// opposite reason: a badly contended runner must not be able to scale the
// ceiling into meaninglessness — past that point, failing is the right answer.
// Measured per-document over this fixture on the reference machine (M3 Pro):
// 193 ms/MB on a quiet one, ~250 with other work running. The lower end is the
// honest reference — using the loaded number would understate every other
// machine's ratio and scale the ceilings too little.
const REFERENCE_MS_PER_MB = 193
const CALIBRATION_BYTES = 2 * 1024 * 1024

async function machineScale() {
  const repoRoot = path.resolve(appDir, '..', '..')
  const tokenize = path.join(repoRoot, 'packages', 'core', 'src', 'tokenize.mjs')
  const { countTokens, warmTokenizer } = await import(tokenize)
  // Per DOCUMENT, not over one concatenated blob. `countTokens` encodes only the
  // first 200,000 characters exactly and extrapolates the rest, so a 2MB string
  // measures a tenth of the work and reads ten times too fast — which is exactly
  // the mistake this calibration made on its first run. The engine calls it once
  // per document, each 10-50KB, so that is the pattern worth timing.
  const docs = []
  for (let i = 0, bytes = 0; bytes < CALIBRATION_BYTES; i += 1) {
    const text = fs.readFileSync(path.join(corpus, `doc-${i}.md`), 'utf8')
    docs.push(text)
    bytes += text.length
  }
  // Build the 2.3MB rank table first. It is a one-time ~800ms block that the
  // engine pays at boot, so charging it to this measurement would make every
  // machine look slow in proportion to nothing.
  warmTokenizer()
  const startedAt = performance.now()
  for (const text of docs) countTokens(text)
  const bytes = docs.reduce((total, text) => total + text.length, 0)
  const msPerMB = (performance.now() - startedAt) / (bytes / 1048576)
  return { msPerMB, scale: Math.min(8, Math.max(1, msPerMB / REFERENCE_MS_PER_MB)) }
}

// Raw throughput is not the whole difference, and CI proved it in two runs:
// the runner calibrated at only 1.38x slower, yet its healthy p95 came in at
// 65ms once and 41ms the next time — a 1.6x spread on identical hardware, from
// contention this measurement cannot see. Scaling by throughput alone put the
// ceiling at 69ms, which clears the worse of those two by 4ms. That is a gate
// that passes today and flakes next week.
//
// So absorb variance in proportion to how far the machine is from the
// reference. A machine that calibrates at 1.0 is the quiet dev box these
// thresholds were measured on and keeps the sharp ceiling; the further from
// that, the more likely it is a shared runner whose noise has to be tolerated.
// This costs sensitivity exactly where sensitivity was already poor — CI cannot
// see a 35ms stall through its own 24ms of jitter either way — and none where
// the gate is actually sharp.
// The 8x cap belongs on the FINAL scale, not the throughput ratio: applying the
// variance factor after a ratio already capped at 8 would let the ceiling reach
// 18.5x, which is not a gate.
const VARIANCE_FACTOR = 2.5
const { msPerMB, scale: rawScale } = await machineScale()
const scale = Math.min(8, 1 + (rawScale - 1) * VARIANCE_FACTOR)
const calibration = `this machine encodes ${msPerMB.toFixed(0)} ms/MB vs ${REFERENCE_MS_PER_MB} on the reference, `
  + `so the ceilings are scaled ${scale.toFixed(2)}x`

// A main process doing the indexing itself blocks for seconds at a stretch;
// isolated, its timers should barely drift. Generous enough to survive a
// loaded CI runner while still failing loudly if the work moves back onto the
// UI thread.
const MAX_LAG_MS = 400

// The engine's own budget, sampled every ~20ms for 1.2s of the same index.
//
// Measured on this fixture, M3 Pro, three consecutive runs (with other work on
// the machine, which is the honest condition to calibrate against):
//   p50 6ms / p95 11ms / max 12ms   (45 probes, 0 failures)
//   p50 6ms / p95 10ms / max 29ms   (43 probes, 0 failures)
//   p50 6ms / p95 12ms / max 18ms   (44 probes, 0 failures)
//
// The old fixture measured p50 2ms / p95 3ms / max 26ms, so the same ceilings
// now sit above a signal ~3x larger: what changed is the measurement, not the
// limits. The limits stay at the plan's API-responsiveness SLO (p95 < 50ms,
// max < 250ms) on purpose — they are the product promise ("you can still
// navigate while it indexes"), and Task 0.2 asks for generous thresholds
// because CI machines vary — and rather than assume by how much, the ceilings
// are scaled by the measured calibration above. A GitHub macos-14 runner
// measured p95 65ms on a healthy engine, which is the number that taught this
// file not to guess.
//
// What that ceiling costs in sensitivity, measured rather than assumed:
//
//   - A synchronous stall injected into the engine's request handler fails the
//     gate from ~35ms per request upward (35ms → p95 51ms, red; 30ms → p95
//     40ms, green). The 300ms busy-wait this file used to cite as proof was an
//     order of magnitude grosser than what it can actually detect.
//   - The regression class it exists for fails it without any artificial stall:
//     replacing the files adapter's awaited `fsp.readFile`/`fsp.stat` with
//     `readFileSync`/`statSync` — the one-line "simplification" that removes
//     the per-document yield — takes p95 to 487ms over 6 probes.
//
// That second one is why the fixture above is what it is. Against the OLD
// corpus the very same sync-I/O regression measured p95 8ms and the gate
// printed ISOLATION OK, twice. The gate did not become stricter here; it became
// able to see.
const MAX_ENGINE_P95_MS = Math.round(50 * scale)
const MAX_ENGINE_MAX_MS = Math.round(250 * scale)
// Guards "the probe loop ran for the window it claims to have run for", and
// that is worth stating precisely, because an empty sample set makes every
// latency assertion above pass vacuously (p50/p95/max all read 0).
//
// The floor is derived from the p95 ceiling rather than picked. The window is
// 1.2s of probes spaced by a 20ms gap, so a run that honors p95 <= 50ms cannot
// produce fewer than ~1200/(50+20) ≈ 17 probes — and for any sample count at or
// below 20 the p95 estimator IS the maximum, so "p95 within budget" really does
// mean every probe was. 12 keeps margin for boot jitter and a partially
// consumed window while staying far below that 17, which is what makes it
// impossible for a merely SLOW engine to fail here: it fails the latency
// assertion first, and this check runs after it, so the message is never the
// wrong one. A healthy run lands at 42-43 on the reference machine.
//
// It has to be derived from the SCALED ceiling, not the reference one. A slower
// machine legitimately fits fewer probes into the same 1.2s window — a runner
// held to p95 285ms can only manage ~4 — so a fixed floor of 12 would fail a
// healthy slow machine with a message about the probe loop being broken, which
// is both wrong and the most confusing kind of wrong.
const MIN_ENGINE_PROBES = Math.max(3, Math.floor((1200 / (MAX_ENGINE_P95_MS + 20)) * 0.7))

// Escape hatch for containers/CI images that need extra Chromium switches
// (e.g. CC_ELECTRON_ARGS="--no-sandbox" when running as root). Unset on a
// normal Mac, where the defaults are correct.
const extraArgs = (process.env.CC_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)

// The engine log is redirected into the sandbox both to keep the test out of
// ~/Library/Logs and so this run can assert the log actually captures pass
// lines — the log is the only crash artifact a Finder-launched app has.
const logDir = path.join(tmp, 'logs')
const child = spawn(electron, [appDir, `--user-data-dir=${userData}`, ...extraArgs], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CC_SMOKE: '1', CC_ENGINE_LOG_DIR: logDir },
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
  // Read before cleanup() — the log lives inside the sandbox it deletes.
  let engineLogText = ''
  try { engineLogText = fs.readFileSync(path.join(logDir, 'engine.log'), 'utf8') } catch { /* asserted below */ }
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
      + `(limits ${MAX_ENGINE_P95_MS}ms / ${MAX_ENGINE_MAX_MS}ms — ${calibration}). `
      + `Main-process lag was ${lag}ms, so the stall is inside the engine's request path, not the UI thread.\n`,
    )
    process.exitCode = 1
    return
  }

  // The engine log must have recorded the pass this run provoked. Asserted on
  // the START line only: the smoke deliberately exits while indexing is still
  // running, so the "done" line may not exist yet.
  if (!engineLogText.includes('[index] ') || !engineLogText.includes('pass 1 start')) {
    process.stdout.write(
      'ISOLATION FAIL: the engine log did not capture the indexing pass '
      + `(engine.log ${engineLogText === '' ? 'is missing or empty' : 'has no [index] pass line'}). `
      + 'A crash during a large index would leave no artifact.\n',
    )
    process.exitCode = 1
    return
  }

  // Last, and deliberately so: a number nobody sampled is not a measurement,
  // and an empty sample set reads as p50/p95/max of 0 — which every assertion
  // above would have passed. Running it after them means a slow engine is
  // always reported as slow rather than as an unsampled one.
  if (engine.probes < MIN_ENGINE_PROBES) {
    process.stdout.write(
      `ISOLATION FAIL: only ${engine.probes} engine probes landed over a 1.2s window `
      + `(expected at least ${MIN_ENGINE_PROBES}, healthy is ~42). The latency numbers `
      + `— p50 ${engine.p50}ms p95 ${engine.p95}ms max ${engine.max}ms — describe too little to mean anything, `
      + 'so the probe loop itself is what broke, not the engine.\n',
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `ISOLATION OK: main process lag ${lag}ms while the engine indexed ${DOCS} documents `
    + `(limit ${MAX_LAG_MS}ms); engine GET /api/status p50 ${engine.p50}ms p95 ${engine.p95}ms `
    + `max ${engine.max}ms over ${engine.probes} probes (limits ${MAX_ENGINE_P95_MS}ms / ${MAX_ENGINE_MAX_MS}ms — ${calibration})\n`,
  )
  process.exitCode = 0
})
