// The shell's answer to a local engine that has stopped answering.
//
// Desktop-only, and by construction inert everywhere else: in a browser there
// is no `__CC_DESKTOP`, so this renders nothing and subscribes to nothing.
//
// It exists because of a gap the failing-refresh banner beside it does not
// cover. That one fires when a *request* fails — the engine refused, or the
// socket broke. A wedged engine does neither: the process is alive, the port is
// bound, and requests simply never come back. The console's own polling can't
// see the difference between "slow" and "never" without a deadline it doesn't
// own, so the measurement lives in the desktop main process (it pings
// GET /api/status on a fixed cadence) and arrives here as a verdict.
//
// Its own state, deliberately: this re-renders on the shell's 10s cadence while
// an engine is wedged, and hanging that off the app store would re-render the
// whole tree for it.
import { useCallback, useEffect, useState } from 'react'
import { formatElapsed } from './BackgroundActivity'
import { C, css } from '../theme'

/**
 * What the desktop shell has concluded about the engine's HTTP loop.
 * `healthy` false means several consecutive pings went unanswered;
 * `canRelaunch` means it has been that way long enough to call it stuck.
 */
export type EngineHealth = {
  healthy: boolean
  misses: number
  unresponsiveMs: number
  canRelaunch: boolean
}

export function EngineBanner() {
  const [state, setState] = useState<EngineHealth | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => window.__CC_DESKTOP?.engine?.onStatus?.((next) => {
    setState(next)
    // A fresh verdict means the previous restart is over, one way or another.
    if (next.healthy) setRestarting(false)
  }), [])

  const restart = useCallback(() => {
    setRestarting(true)
    // The restart reloads this window at the new engine origin, so there is no
    // success path to render here — only the failure to hand back control.
    window.__CC_DESKTOP?.engine?.relaunch?.().catch(() => setRestarting(false))
  }, [])

  if (!state || state.healthy) return null

  return (
    <div
      role="status"
      style={css(`display:flex; align-items:center; gap:10px; padding:8px 16px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; font-size:12px; color:${C.amberText};`)}
    >
      <span aria-hidden="true">⚠</span>
      <span style={css('flex:1 1 auto; min-width:0; overflow-wrap:anywhere;')}>
        The engine is busy — a large source may be indexing. What is on screen is the last
        thing it told us.
        {state.canRelaunch && ` It has not answered for ${formatElapsed(state.unresponsiveMs)}.`}
      </span>
      {state.canRelaunch && (
        <button
          type="button"
          className="cc-activity-action"
          disabled={restarting}
          onClick={restart}
        >{restarting ? 'Restarting…' : 'Restart Engine'}</button>
      )}
    </div>
  )
}
