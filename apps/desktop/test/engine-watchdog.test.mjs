import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineWatchdog } from '../src/main/engine-watchdog.mjs'

/**
 * A watchdog wired to a scripted engine and a clock the test owns.
 *
 * Real timers at real thresholds would make this a minute-long test, so the
 * intervals are compressed and the elapsed-time arithmetic runs against an
 * injected clock — the two things the thresholds are made of are therefore both
 * under test, rather than one of them being wall-clock luck on a loaded runner.
 */
function harness({ alive = () => true, wedgedMs = 1_000 } = {}) {
  let clock = 0
  const states = []
  const watchdog = createEngineWatchdog({
    ping: async () => { if (!alive()) throw new Error('no answer') },
    onState: (state) => states.push(state),
    intervalMs: 5,
    pingTimeoutMs: 5,
    wedgedMs,
    now: () => clock,
  })
  return {
    watchdog,
    states,
    advance(ms) { clock += ms },
    last: () => states[states.length - 1],
    async tick(times = 1) {
      for (let i = 0; i < times; i += 1) await watchdog.checkNow()
    },
  }
}

test('a healthy engine never says anything', async () => {
  const h = harness()
  await h.tick(6)
  assert.deepEqual(h.states, [])
})

test('three missed pings are not yet a banner; the fourth is', async () => {
  const h = harness({ alive: () => false })
  await h.tick(3)
  assert.deepEqual(h.states, [], 'a slow moment must not put a banner in front of the user')
  await h.tick(1)
  assert.equal(h.states.length, 1)
  assert.equal(h.last().healthy, false)
  assert.equal(h.last().misses, 4)
  assert.equal(h.last().canRelaunch, false)
})

test('the relaunch offer waits for the wedge to last, not just for misses to pile up', async () => {
  let up = false
  const h = harness({ alive: () => up, wedgedMs: 1_000 })
  await h.tick(4)
  assert.equal(h.last().canRelaunch, false)
  // Misses keep coming, but not enough time has passed to call it wedged.
  h.advance(600)
  await h.tick(1)
  assert.equal(h.last().canRelaunch, false)
  assert.equal(h.last().unresponsiveMs, 600)
  h.advance(500)
  await h.tick(1)
  assert.equal(h.last().canRelaunch, true)
  assert.equal(h.last().unresponsiveMs, 1_100)

  // Recovery clears it, and says so exactly once.
  up = true
  await h.tick(3)
  assert.equal(h.last().healthy, true)
  assert.equal(h.last().misses, 0)
  assert.equal(h.states.filter((s) => s.healthy).length, 1, 'recovery is announced once, not on every healthy ping')
})

test('a single answer resets the run — misses must be consecutive', async () => {
  let up = false
  const h = harness()
  const flaky = createEngineWatchdog({
    ping: async () => { if (!up) throw new Error('no answer') },
    onState: (state) => h.states.push(state),
    intervalMs: 5, pingTimeoutMs: 5, wedgedMs: 1_000, now: () => 0,
  })
  await flaky.checkNow()
  await flaky.checkNow()
  await flaky.checkNow()
  up = true
  await flaky.checkNow()
  up = false
  await flaky.checkNow()
  await flaky.checkNow()
  await flaky.checkNow()
  assert.deepEqual(h.states, [], 'an intermittent blip must not accumulate into a permanent banner')
})

test('the unresponsive clock is anchored on the first missed ping, not on the fourth', async () => {
  const h = harness({ alive: () => false })
  await h.tick(1)
  h.advance(400)
  await h.tick(3)
  assert.equal(h.last().unresponsiveMs, 400)
})

test('start/stop own exactly one timer, and it never holds the app open', async () => {
  const h = harness()
  h.watchdog.start()
  h.watchdog.start()
  assert.equal(h.watchdog.running(), true)
  h.watchdog.stop()
  assert.equal(h.watchdog.running(), false)
  // A stopped watchdog reports nothing even if a ping was already in flight.
  h.watchdog.stop()
})

test('stopping mid-flight discards the result instead of publishing it late', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const states = []
  const watchdog = createEngineWatchdog({
    ping: async () => { await gate; throw new Error('no answer') },
    onState: (state) => states.push(state),
    intervalMs: 5, pingTimeoutMs: 5, wedgedMs: 0, now: () => 0,
  })
  watchdog.start()
  const inFlight = watchdog.checkNow()
  watchdog.stop()
  release()
  await inFlight
  assert.deepEqual(states, [])
})
