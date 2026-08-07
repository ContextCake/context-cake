import assert from 'node:assert/strict'
import test from 'node:test'
import { createAckChannel } from '../src/main/ack-channel.mjs'

function channel(timeoutMs = 20) {
  const posted = []
  const ack = createAckChannel({ post: (message) => posted.push(message), timeoutMs })
  return { ack, posted }
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
  assert.deepEqual(await ack.send({ type: 'reload' }), { acked: false, reason: 'timeout' })
})

test('a late acknowledgement after a timeout is ignored, not a double settle', async () => {
  const { ack, posted } = channel(10)
  const result = await ack.send({ type: 'reload' })
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
