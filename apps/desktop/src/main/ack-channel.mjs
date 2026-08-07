// Request/acknowledge bookkeeping for the engine's message port.
//
// Split out of service-host.mjs so the one property that matters here is
// testable without an Electron utilityProcess: a caller must be able to tell a
// real acknowledgement from a deadline that expired. The old inline version
// resolved the same empty promise either way, so `await service.reload()`
// returned identically whether the engine had re-read the manifest or had
// stopped answering entirely — the app then carried on as though a wedged
// engine had agreed with it.
//
// Nothing here REJECTS. These promises are routinely created on paths that
// don't await them (a settings pull reloads the engine and moves on), and an
// unhandled rejection on the main process is a crash dialog.

/**
 * @param {{ post: (message: object) => void, timeoutMs: number }} options
 *   `post` hands a message to the child; it may throw if the port is gone.
 * @returns a channel whose `send` resolves to `{acked: true}` or
 *   `{acked: false, reason}` — never to an ambiguous undefined.
 */
export function createAckChannel({ post, timeoutMs }) {
  let nextId = 1
  let closedReason = null
  /** @type {Map<number, {done: (result: object) => void, timer: NodeJS.Timeout}>} */
  const inFlight = new Map()

  function finish(id, result) {
    const entry = inFlight.get(id)
    if (!entry) return false
    inFlight.delete(id)
    clearTimeout(entry.timer)
    entry.done(result)
    return true
  }

  return {
    send(payload) {
      if (closedReason) return Promise.resolve({ acked: false, reason: closedReason })
      return new Promise((done) => {
        const id = nextId++
        // A deadline, not an answer: whatever happens the caller stops waiting,
        // and learns which of the two it got.
        const timer = setTimeout(() => finish(id, { acked: false, reason: 'timeout' }), timeoutMs)
        timer.unref?.()
        inFlight.set(id, { done, timer })
        try {
          post({ ...payload, id })
        } catch {
          finish(id, { acked: false, reason: 'send-failed' })
        }
      })
    },

    /** The child answered. A late ack for an already-expired id is a no-op. */
    settle(id) {
      return finish(id, { acked: true })
    },

    /**
     * The channel is finished — the child exited, or the app is shutting down.
     * Everything owed is answered with `reason` and nothing new is accepted.
     */
    close(reason = 'closing') {
      closedReason = reason
      for (const id of [...inFlight.keys()]) finish(id, { acked: false, reason })
    },

    pending: () => inFlight.size,
  }
}
