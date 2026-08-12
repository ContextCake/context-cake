// Liveness for an engine that is still running but has stopped answering.
//
// An engine EXIT is already handled elsewhere (service-host.mjs's onCrash →
// main.mjs's handleEngineCrash: bounded restart, breadcrumbs, quarantine).
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
/**
 * Per-ping deadline, enforced here rather than delegated to the ping.
 *
 * A hung socket has to count as a miss, and the only way to guarantee that is
 * to stop waiting on our own clock: a ping that ignores its abort signal — or
 * a promise that simply never settles — would otherwise leave the watchdog
 * waiting forever and therefore permanently silent, which is exactly the
 * failure it exists to report.
 */
export const PING_TIMEOUT_MS = 5_000
/** Misses tolerated silently. The banner appears on the one AFTER this. */
export const MISS_THRESHOLD = 3
/** How long unresponsive before relaunching is offered. */
export const WEDGED_MS = 60_000

/**
 * Should the relaunch OFFER be shown, given a fresh out-of-band status probe?
 *
 * The watchdog's 5s ping deadline measures responsiveness; this measures
 * aliveness-with-progress. A heavy index pass can miss enough pings to raise
 * the wedge banner while the engine is demonstrably WORKING — and a user who
 * accepts the restart throws all of that progress away. So before the modal:
 * one longer probe, and if it answers with indexing that has MOVED since the
 * last look, hold the offer (the banner stays; the next tick re-probes).
 * Suppression requires observed progress: two consecutive no-progress probes
 * always fall through, so a real wedge is delayed by at most one interval,
 * never hidden.
 *
 * Pure — main.mjs owns the probe and the dialog — so every branch is
 * unit-testable without a wedged engine.
 *
 * @param {null | { indexing: boolean, loadedBySource: Record<string, number> }} previous
 *   The status the last suppressed offer saw (null on the first offer).
 * @param {null | { indexing: boolean, loadedBySource: Record<string, number> }} fresh
 *   The out-of-band probe's answer (null when the probe failed).
 */
export function shouldOfferRelaunch(previous, fresh) {
  if (!fresh) return true // the longer probe failed too: genuinely stuck
  if (fresh.indexing !== true) return true // not working, just not answering
  if (!previous) return false // first look at an indexing engine: give it one interval
  const sources = new Set([...Object.keys(previous.loadedBySource ?? {}), ...Object.keys(fresh.loadedBySource ?? {})])
  for (const name of sources) {
    if ((fresh.loadedBySource?.[name] ?? 0) !== (previous.loadedBySource?.[name] ?? 0)) return false // progress
  }
  return true // indexing in name only — counters frozen since the last look
}

/**
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<unknown>} options.ping Resolves if
 *   the engine answered at all — any HTTP status proves its loop is turning.
 *   Rejects on transport failure. It is handed a signal that is aborted at the
 *   deadline and on stop(), and should abandon the request when it fires; a
 *   ping that ignores it is still counted as a miss on time, because the
 *   deadline is enforced here rather than trusted to the caller.
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
  let armed = false
  // Which engine a check is speaking about. Bumped by stop(); a check captures
  // it before its ping goes out and drops the result if it moved.
  //
  // This was a boolean, and a boolean cannot express the case it was written
  // for. A relaunch is stop() → fork → start(), and the ping to the OLD engine
  // is still out across all of it (5s deadline against a ~1s swap), so by the
  // time it lands `stopped` is false again and the dead engine's answer is
  // read as the new engine's first healthy ping — clearing a banner on the
  // strength of a process that no longer exists.
  let watch = 0
  // The ping currently out, so stop() can release its socket instead of
  // leaving it held until the deadline it will never reach.
  let pending = null

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

  /**
   * One ping, resolved to answered/not-answered on this watchdog's clock.
   *
   * Never rejects, and always settles: the deadline resolves the check whether
   * or not the ping ever comes back, and fires the abort at it so a hung
   * request releases its socket. Both handlers are attached to the ping's own
   * promise, so an abandoned one that rejects later is still handled — an
   * unhandled rejection on the main process is the app's fatal handler.
   */
  function runPing(controller) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (answered) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(answered)
      }
      const deadline = setTimeout(() => {
        controller.abort(new Error('engine ping deadline'))
        finish(false)
      }, pingTimeoutMs)
      // Same rule as the interval: never the reason the process stays alive.
      deadline.unref?.()
      let out
      // A ping that throws synchronously is a miss, not a crash.
      try { out = Promise.resolve(ping?.(controller.signal)) } catch (err) { out = Promise.reject(err) }
      out.then(() => finish(true), () => finish(false))
    })
  }

  async function check() {
    // Not armed: either never started, or deliberately stopped. checkNow()
    // reaches here from the unacked-message path, which a SHUTDOWN also travels
    // (closing the service resolves every pending ack with `acked:false`), so
    // this must not become a ping at an engine that is being closed.
    if (!armed) return
    // A ping already out means the previous one is past its deadline or the
    // loop is saturated; either way, starting a second proves nothing.
    if (inFlight) return
    const epoch = watch
    const controller = new AbortController()
    inFlight = true
    pending = controller
    const startedAt = now()
    let answered = false
    try {
      answered = await runPing(controller)
    } finally {
      inFlight = false
      if (pending === controller) pending = null
    }
    // Stopped, or the engine was swapped, while the ping was out: the answer
    // describes an engine this watchdog is no longer responsible for.
    if (epoch !== watch) return
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
      armed = true
      if (timer) return
      // Fire-and-forget, and it must stay that way: an unhandled rejection on
      // the main process is the app's fatal handler. A watchdog that can kill
      // the app it watches is worse than no watchdog.
      timer = setInterval(() => { check().catch(() => {}) }, intervalMs)
      // The watchdog must never be the reason the process stays alive.
      timer.unref?.()
    },
    stop() {
      armed = false
      watch += 1
      if (timer) clearInterval(timer)
      timer = null
      // The ping still out belongs to the engine that is going away. Abort it
      // rather than letting it hold a socket until a deadline nobody is
      // waiting on any more.
      pending?.abort(new Error('engine watchdog stopped'))
      pending = null
      misses = 0
      firstMissAt = null
      // `announcedUnhealthy` deliberately SURVIVES a stop. It records what the
      // window was last told, not what the engine was doing — and the relaunch
      // path (stop → fork → start) leaves the old engine's banner on screen.
      // Clearing it here would make the new engine's first healthy answer "not
      // news", so the banner would sit over a working engine until the next
      // outage. The state that describes the engine is reset; the state that
      // describes the user's screen is not.
    },
    /**
     * Ping now rather than at the next tick — used when a message-port
     * acknowledgement went missing. Deliberately does NOT arm: this same path
     * runs during shutdown, and arming there restarted a watchdog that had just
     * been stopped, pinged an engine that was being closed, and carried the
     * resulting miss into the next engine's count.
     */
    checkNow() {
      return check()
    },
    running: () => timer != null,
    state: snapshot,
  }
}
