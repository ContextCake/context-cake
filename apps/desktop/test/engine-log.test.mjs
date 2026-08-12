import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lineSink, openEngineLog } from '../src/main/engine-log.mjs'

const FIXED_NOW = () => new Date('2026-08-12T10:00:00.000Z')

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-engine-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('writes stamped events and raw lines to engine.log', async (t) => {
  const dir = tmpdir(t)
  const log = openEngineLog(dir, { now: FIXED_NOW })
  assert.ok(log, 'log opens in a writable dir')
  log.logEvent('engine starting')
  log.writeRaw('2026-08-12T10:00:01.000Z [engine] [index] vault: pass 1 start\n')
  await log.close()
  const text = fs.readFileSync(log.path, 'utf8')
  assert.match(text, /^2026-08-12T10:00:00\.000Z \[app\] engine starting\n/)
  assert.match(text, /\[index\] vault: pass 1 start\n/)
})

test('rotates an oversized log aside once, at open', async (t) => {
  const dir = tmpdir(t)
  const file = path.join(dir, 'engine.log')
  fs.writeFileSync(file, 'old contents\n')
  // A tiny maxBytes makes the seeded file "oversized" without writing 5MB.
  const log = openEngineLog(dir, { maxBytes: 4, now: FIXED_NOW })
  log.logEvent('fresh run')
  await log.close()
  assert.equal(fs.readFileSync(path.join(dir, 'engine.log.1'), 'utf8'), 'old contents\n')
  const fresh = fs.readFileSync(file, 'utf8')
  assert.ok(!fresh.includes('old contents'), 'the new log starts empty')
  assert.match(fresh, /fresh run/)
})

test('rotation replaces the previous .1 so the pair stays bounded', async (t) => {
  const dir = tmpdir(t)
  fs.writeFileSync(path.join(dir, 'engine.log'), 'newer old log\n')
  fs.writeFileSync(path.join(dir, 'engine.log.1'), 'ancient log\n')
  const log = openEngineLog(dir, { maxBytes: 4 })
  await log.close()
  assert.equal(fs.readFileSync(path.join(dir, 'engine.log.1'), 'utf8'), 'newer old log\n')
})

test('an unwritable directory yields null, never a throw', (t) => {
  const dir = tmpdir(t)
  const notADir = path.join(dir, 'occupied')
  fs.writeFileSync(notADir, 'a file where the dir should go')
  assert.equal(openEngineLog(path.join(notADir, 'logs')), null)
})

test('lineSink flushes whole lines only, stamped and tagged', () => {
  const out = []
  const sink = lineSink((line) => out.push(line), 'engine', { now: FIXED_NOW })
  sink('first li')
  assert.deepEqual(out, [], 'a partial line is buffered, not emitted')
  sink('ne\nsecond line\ntail')
  assert.deepEqual(out, [
    '2026-08-12T10:00:00.000Z [engine] first line\n',
    '2026-08-12T10:00:00.000Z [engine] second line\n',
  ])
  sink.flush()
  assert.equal(out.length, 3, 'flush emits the unterminated tail')
  assert.match(out[2], /tail\n$/)
  sink.flush()
  assert.equal(out.length, 3, 'a second flush has nothing to say')
})
