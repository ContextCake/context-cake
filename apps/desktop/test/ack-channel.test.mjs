import assert from 'node:assert/strict'
import test from 'node:test'
import { createAckChannel } from '../src/main/ack-channel.mjs'

function channel(timeoutMs = 20) {
  const posted = []
  const ack = createAckChannel({ post: (message) => posted.push(message), timeoutMs })
  return { ack, posted }
}

/**
 * Await something whose only pending work is the channel's deadline timer.
 *
 * That timer is `unref()`ed on purpose — an ack deadline must never be the
 * reason the app stays open — which means that in a test with nothing else
 * running, the loop empties and the timer never fires. Node 24 happened to
 * survive this; Node 22 (which CI runs) reports "Promise resolution is still
 * pending but the event loop has already resolved" and cancels the rest of the
 * file. A ref'd keepalive is the test's job, not the channel's: dropping the
 * `unref()` to make a test pass would put a 15-second stall into every quit.
 */
async function awaitingADeadline(promise) {
  const keepalive = setInterval(() => {}, 1_000)
  try { return await promise } finally { clearInterval(keepalive) }
}

test('a real acknowledgement is distinguishable from a missed one', async () => {
  const { ack, posted } = channel()
  const pending = ack.send({ type: 'reload' })
  assert.equal(posted.length, 1)
  ack.settle(posted[0].id)
  assert.deepEqual(await pending, { acked: true })
})

test('a missed acknowledgement resolves as a timeout, never as success', async () => {
  const { ack } = channel(10)
  assert.deepEqual(await awaitingADeadline(ack.send({ type: 'reload' })), { acked: false, reason: 'timeout' })
})

test('a late acknowledgement after a timeout is ignored, not a double settle', async () => {
  const { ack, posted } = channel(10)
  const result = await awaitingADeadline(ack.send({ type: 'reload' }))
  assert.equal(result.acked, false)
  // The engine finally answers. Nothing is waiting; this must not throw.
  ack.settle(posted[0].id)
})

test('each send gets its own id, and settling one leaves the others pending', async () => {
  const { ack, posted } = channel(60)
  const first = ack.send({ type: 'reload' })
  const second = ack.send({ type: 'tokens' })
  assert.notEqual(posted[0].id, posted[1].id)
  ack.settle(posted[1].id)
  assert.deepEqual(await second, { acked: true })
  ack.settle(posted[0].id)
  assert.deepEqual(await first, { acked: true })
})

test('a post that throws resolves immediately rather than waiting out the deadline', async () => {
  const ack = createAckChannel({
    post: () => { throw new Error('message port is gone') },
    timeoutMs: 60_000,
  })
  assert.deepEqual(await ack.send({ type: 'reload' }), { acked: false, reason: 'send-failed' })
})

test('closing abandons everything in flight and refuses new sends', async () => {
  const { ack } = channel(60_000)
  const pending = ack.send({ type: 'reload' })
  ack.close('exit')
  assert.deepEqual(await pending, { acked: false, reason: 'exit' })
  assert.deepEqual(await ack.send({ type: 'reload' }), { acked: false, reason: 'exit' })
})

test('pending count is observable so a caller can tell whether anything is owed', async () => {
  const { ack, posted } = channel(60_000)
  assert.equal(ack.pending(), 0)
  const inFlight = ack.send({ type: 'reload' })
  assert.equal(ack.pending(), 1)
  ack.settle(posted[0].id)
  await inFlight
  assert.equal(ack.pending(), 0)
})
