// The engine's only durable diagnostic trail. A Finder-launched app has no
// terminal: before this file, the utility process wrote to stdio 'inherit',
// which for a .app is /dev/null, so an engine that died mid-index left nothing
// on disk at all — the only artifact was whatever crash report macOS chose to
// write. Everything here is plain text on the local disk; nothing is ever
// sent anywhere.
//
// Deliberately Electron-free (same doctrine as metrics-consent.mjs) so
// `npm test` can drive it with plain `node --test`: the caller supplies the
// directory, this module never asks the app object for it.
import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024

/**
 * Open (and rotate) the engine log at `dir`/engine.log.
 *
 * Rotation happens once, at open: a log past `maxBytes` becomes engine.log.1
 * (replacing the previous .1), so the pair is bounded at ~2× maxBytes per
 * install. In-flight size is not policed — one app run writing 5MB of engine
 * output is a bug worth seeing whole, not truncating.
 *
 * Every failure path returns or degrades to a no-op: the log exists to explain
 * crashes, so it must never cause one. `null` from this function (unwritable
 * dir) is a valid, silent outcome the caller treats like a log with no pen.
 */
export function openEngineLog(dir, { maxBytes = MAX_LOG_BYTES, now = () => new Date() } = {}) {
  let stream
  const file = path.join(dir, 'engine.log')
  try {
    fs.mkdirSync(dir, { recursive: true })
    try {
      const { size } = fs.statSync(file)
      if (size > maxBytes) fs.renameSync(file, path.join(dir, 'engine.log.1'))
    } catch { /* no existing log — nothing to rotate */ }
    stream = fs.createWriteStream(file, { flags: 'a' })
    // A full disk or a yanked volume surfaces as a stream error; swallowing it
    // is the entire point of having a stream error handler here.
    stream.on('error', () => {})
  } catch {
    return null
  }

  const stamp = () => now().toISOString()

  return {
    path: file,
    /** Raw engine output, already newline-shaped by lineSink() below. */
    writeRaw(text) {
      try { stream.write(text) } catch { /* log must never throw */ }
    },
    /** One main-process breadcrumb (crash, restart attempt, quarantine). */
    logEvent(line) {
      try { stream.write(`${stamp()} [app] ${String(line).trimEnd()}\n`) } catch { /* ditto */ }
    },
    /** Resolves once buffered writes have landed — tests depend on that. */
    close() {
      return new Promise((resolve) => {
        try { stream.end(resolve) } catch { resolve() }
      })
    },
  }
}

/**
 * A chunk consumer that emits complete, timestamped lines to `write`.
 *
 * Child stdout/stderr arrive as arbitrary chunks, not lines; stamping each
 * chunk would split lines mid-word. This buffers the partial tail and flushes
 * whole lines only. `flush()` empties the tail (call it when the child exits,
 * or a final unterminated line is lost).
 */
export function lineSink(write, tag, { now = () => new Date() } = {}) {
  let tail = ''
  const emit = (line) => write(`${now().toISOString()} [${tag}] ${line}\n`)
  const consume = (chunk) => {
    tail += String(chunk)
    let nl
    while ((nl = tail.indexOf('\n')) !== -1) {
      emit(tail.slice(0, nl).trimEnd())
      tail = tail.slice(nl + 1)
    }
  }
  consume.flush = () => {
    if (tail.trim() !== '') emit(tail.trimEnd())
    tail = ''
  }
  return consume
}
