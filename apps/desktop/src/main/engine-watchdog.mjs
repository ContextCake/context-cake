// Liveness for an engine that is still running but has stopped answering.
//
// An engine EXIT is already handled and already fatal (service-host.mjs's
// onCrash → the clean dialog-and-exit of specs/contextcake-distribution/design.md).
// A WEDGE is the other failure and deliberately does not take that path: the
// process is alive, its HTTP server is bound, and the app looks fine while
// every request hangs. Nothing measured that before, so the only symptom a user
// got was a window that had quietly stopped changing.
//
// So: ping the cheapest endpoint there is on a fixed cadence, count CONSECUTIVE
// failures, and tell the window. Two thresholds, because they answer different
// questions:
//   - more than `missThreshold` misses  → say something. A large source can
//     make the engine slow; that is worth a note, not an intervention.
//   - unresponsive for `wedgedMs`       → offer to relaunch it. By then it is
//     not slow, it is stuck, and waiting longer has stopped being a strategy.
//
// The wedge clock is anchored on the FIRST missed ping rather than on the one
// that crossed the threshold — that is the earliest moment there is evidence
// for, and anchoring later would understate the outage by half a minute.

/** Cadence of the liveness ping. Cheap: /api/status is O(sources), ~370 bytes. */
export const PING_INTERVAL_MS = 10_000
/** Per-ping deadline. A hung socket has to count as a miss, not stall the loop. */
export const PING_TIMEOUT_MS = 5_000
/** Misses tolerated silently. The banner appears on the one AFTER this. */
export const MISS_THRESHOLD = 3
/** How long unresponsive before relaunching is offered. */
export const WEDGED_MS = 60_000

/**
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<unknown>} options.ping Resolves if
 *   the engine answered at all — any HTTP status proves its loop is turning.
 *   Rejects on timeout or transport failure.
 * @param {(state: {healthy: boolean, misses: number, unresponsiveMs: number, canRelaunch: boolean}) => void} options.onState
 *   Called while unresponsive (so the elapsed time stays current) and exactly
 *   once on recovery. A healthy engine that has never faltered says nothing.
 */
export function createEngineWatchdog({
  ping,
  onState,
  intervalMs = PING_INTERVAL_MS,
  pingTimeoutMs = PING_TIMEOUT_MS,
  missThreshold = MISS_THRESHOLD,
  wedgedMs = WEDGED_MS,
  now = Date.now,
} = {}) {
  let timer = null
  let inFlight = false
  let misses = 0
  let firstMissAt = null
  let announcedUnhealthy = false
  // Set by stop() and cleared by start(), so a result that lands after a stop
  // (or after a relaunch swapped the engine underneath) is discarded.
  let stopped = true

  function snapshot() {
    const unresponsiveMs = firstMissAt == null ? 0 : Math.max(0, now() - firstMissAt)
    const healthy = misses <= missThreshold
    return { healthy, misses, unresponsiveMs, canRelaunch: !healthy && unresponsiveMs >= wedgedMs }
  }

  function publish() {
    const state = snapshot()
    if (!state.healthy) {
      announcedUnhealthy = true
      onState?.(state)
      return
    }
    // Recovery is news exactly once. Every healthy ping after it is not.
    if (!announcedUnhealthy) return
    announcedUnhealthy = false
    onState?.(state)
  }

  async function check() {
    // A ping already out means the previous one is past its deadline or the
    // loop is saturated; either way, starting a second proves nothing.
    if (inFlight) return
    inFlight = true
    const startedAt = now()
    let answered = false
    try {
      await ping(AbortSignal.timeout(pingTimeoutMs))
      answered = true
    } catch {
      answered = false
    } finally {
      inFlight = false
    }
    // Stopped while the ping was out: the answer describes an engine this
    // watchdog is no longer responsible for.
    if (stopped) return
    if (answered) {
      misses = 0
      firstMissAt = null
    } else {
      misses += 1
      firstMissAt ??= startedAt
    }
    publish()
  }

  return {
    start() {
      stopped = false
      if (timer) return
      // Fire-and-forget, and it must stay that way: an unhandled rejection on
      // the main process is the app's fatal handler. A watchdog that can kill
      // the app it watches is worse than no watchdog.
      timer = setInterval(() => { check().catch(() => {}) }, intervalMs)
      // The watchdog must never be the reason the process stays alive.
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      misses = 0
      firstMissAt = null
    },
    /** Ping now — used when a message-port acknowledgement went missing. */
    checkNow() {
      stopped = false
      return check()
    },
    running: () => timer != null,
    state: snapshot,
  }
}
