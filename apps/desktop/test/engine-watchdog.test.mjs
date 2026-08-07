import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineWatchdog } from '../src/main/engine-watchdog.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A watchdog wired to a scripted engine and a clock the test owns.
 *
 * Real timers at real thresholds would make this a minute-long test, so the
 * elapsed-time arithmetic runs against an injected clock — the two things the
 * thresholds are made of are therefore both under test, rather than one of them
 * being wall-clock luck on a loaded runner.
 *
 * The interval is set to an hour and every check is driven explicitly through
 * `checkNow()`. The watchdog is nonetheless STARTED, because "started" is the
 * state it is in for the whole life of the app — a test that drives a watchdog
 * which was never armed is testing a configuration that never ships, and that
 * is how the stop-guard went untested: `checkNow()` used to arm it as a side
 * effect, so the tests never noticed that nothing else did.
 */
function harness(t, { alive = () => true, ping, wedgedMs = 1_000, pingTimeoutMs = 20 } = {}) {
  let clock = 0
  const states = []
  const signals = []
  const watchdog = createEngineWatchdog({
    ping: (signal) => {
      signals.push(signal)
      if (ping) return ping(signal)
      if (!alive()) return Promise.reject(new Error('no answer'))
      return Promise.resolve('ok')
    },
    onState: (state) => states.push(state),
    intervalMs: 3_600_000,
    pingTimeoutMs,
    wedgedMs,
    now: () => clock,
  })
  watchdog.start()
  t?.after(() => watchdog.stop())
  return {
    watchdog,
    states,
    signals,
    pings: () => signals.length,
    advance(ms) { clock += ms },
    last: () => states[states.length - 1],
    async tick(times = 1) {
      for (let i = 0; i < times; i += 1) await watchdog.checkNow()
    },
  }
}

test('a healthy engine never says anything', async (t) => {
  const h = harness(t)
  await h.tick(6)
  assert.deepEqual(h.states, [])
})

test('three missed pings are not yet a banner; the fourth is', async (t) => {
  const h = harness(t, { alive: () => false })
  await h.tick(3)
  assert.deepEqual(h.states, [], 'a slow moment must not put a banner in front of the user')
  await h.tick(1)
  assert.equal(h.states.length, 1)
  assert.equal(h.last().healthy, false)
  assert.equal(h.last().misses, 4)
  assert.equal(h.last().canRelaunch, false)
})

test('the relaunch offer waits for the wedge to last, not just for misses to pile up', async (t) => {
  let up = false
  const h = harness(t, { alive: () => up, wedgedMs: 1_000 })
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

test('a single answer resets the run — misses must be consecutive', async (t) => {
  let up = false
  const h = harness(t, { alive: () => up })
  await h.tick(3)
  up = true
  await h.tick(1)
  up = false
  await h.tick(3)
  assert.deepEqual(h.states, [], 'an intermittent blip must not accumulate into a permanent banner')
})

test('the unresponsive clock is anchored on the first missed ping, not on the fourth', async (t) => {
  const h = harness(t, { alive: () => false })
  await h.tick(1)
  h.advance(400)
  await h.tick(3)
  assert.equal(h.last().unresponsiveMs, 400)
})

test('start/stop own exactly one timer, and it never holds the app open', async (t) => {
  const h = harness(t)
  assert.equal(h.watchdog.running(), true)
  h.watchdog.start()
  assert.equal(h.watchdog.running(), true)
  h.watchdog.stop()
  assert.equal(h.watchdog.running(), false)
  // Stopping twice is not an error; every quit path calls it.
  h.watchdog.stop()
  assert.equal(h.watchdog.running(), false)
})

// --- Results that arrive after the watchdog stopped watching -----------------
//
// Each of the next three tests drives the miss count PAST the threshold before
// the interesting part. That is not decoration: `publish()` returns early for
// any state it considers healthy, so a test that produces a single miss cannot
// tell a working guard from a missing one — with `if (stopped) return` deleted,
// the old version of this file stayed green.

test('a result that lands after stop() is never published — not as a miss, and not as a recovery', async (t) => {
  let hold = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = harness(t, {
    ping: async () => {
      if (hold) await gate
      throw new Error('no answer')
    },
  })
  await h.tick(4)
  assert.equal(h.states.length, 1, 'the banner is up before the stop')

  hold = true
  const stale = h.watchdog.checkNow()
  h.watchdog.stop()
  release()
  await stale
  assert.equal(
    h.states.length, 1,
    'stop() zeroes the miss count, so a late result publishes a RECOVERY for an engine that was just torn down',
  )
})

test('an answer from the engine that was torn down cannot clear the new engine\'s banner', async (t) => {
  let hold = false
  let alive = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = harness(t, {
    ping: async () => {
      if (hold) await gate
      if (!alive) throw new Error('no answer')
      return 'ok'
    },
  })
  await h.tick(4)
  assert.equal(h.states.length, 1)

  // The relaunch path exactly: a ping to the old engine is still out when the
  // engine is torn down and a new one is started in its place. `stopped` is a
  // boolean, and start() clears it — so the old engine's answer lands looking
  // like the new engine's first healthy ping.
  hold = true
  const stale = h.watchdog.checkNow()
  h.watchdog.stop()
  h.watchdog.start()
  alive = true
  release()
  await stale
  assert.equal(
    h.states.length, 1,
    'a ping answered by the dead engine must not be counted as evidence about the new one',
  )
})

test('checkNow() does not re-arm a watchdog that was deliberately stopped', async (t) => {
  const h = harness(t, { alive: () => false })
  await h.tick(4)
  const pingsBeforeStop = h.pings()
  h.watchdog.stop()

  // shutdownEngine() stops the watchdog and then closes the service, which
  // resolves every pending message-port ack with `acked:false` — and that path
  // calls checkNow(). It must not restart the watchdog against an engine that
  // is being closed.
  await h.watchdog.checkNow()
  assert.equal(h.pings(), pingsBeforeStop, 'a stopped watchdog must not ping')
  assert.equal(h.watchdog.running(), false, 'checkNow() must not re-arm the interval either')
  assert.equal(h.states.length, 1, 'and it must not publish anything about the engine being closed')
})

test('after a relaunch the new engine\'s first healthy answer clears the banner', async (t) => {
  let up = false
  const h = harness(t, { alive: () => up })
  await h.tick(4)
  assert.equal(h.last().healthy, false)

  // relaunchEngine() reuses this watchdog instance across the swap. The banner
  // the old engine raised is still on the user's screen, so the flag recording
  // that has to survive stop() — otherwise the recovery is "not news" and the
  // banner stays up over a perfectly healthy engine.
  h.watchdog.stop()
  h.watchdog.start()
  up = true
  await h.tick(1)
  assert.equal(h.last().healthy, true)
  assert.equal(h.states.filter((s) => s.healthy).length, 1)
})

// --- The ping itself ---------------------------------------------------------

test('a ping that never settles counts as a miss instead of silencing the watchdog', async (t) => {
  const h = harness(t, { ping: () => new Promise(() => {}), pingTimeoutMs: 10 })
  const finished = await Promise.race([h.tick(4).then(() => true), sleep(2_000).then(() => false)])
  assert.equal(
    finished, true,
    'the deadline has to be the watchdog\'s, not the caller\'s: a ping that ignores its signal '
    + 'left `inFlight` true forever and made the watchdog permanently silent — the exact failure it reports',
  )
  assert.equal(h.last().healthy, false)
  assert.equal(h.last().misses, 4)
})

test('a hung ping is aborted — at its deadline, and again when the watchdog stops', async (t) => {
  const h = harness(t, { ping: () => new Promise(() => {}), pingTimeoutMs: 30 })
  const first = h.watchdog.checkNow()
  assert.equal(h.signals[0].aborted, false)
  // A ping runs forever, so a socket held past its deadline is a slow leak.
  await first
  assert.equal(h.signals[0].aborted, true, 'the deadline must reach the socket, not just the bookkeeping')

  const second = h.watchdog.checkNow()
  assert.equal(h.signals[1].aborted, false)
  h.watchdog.stop()
  assert.equal(h.signals[1].aborted, true, 'stop() must release the socket now, not at the ping\'s own deadline')
  await second
})

test('a ping that throws synchronously does not wedge the watchdog', async (t) => {
  const h = harness(t, { ping: () => { throw new Error('the engine is not running') } })
  await h.tick(4)
  assert.equal(h.last().healthy, false)
  assert.equal(h.last().misses, 4, 'a synchronous throw is a miss like any other, and must not strand inFlight')
})
