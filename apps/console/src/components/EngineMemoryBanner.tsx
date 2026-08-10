// The shell's answer to the engine running dangerously low on memory.
//
// Desktop-only, and inert everywhere else: in a browser there is no
// `__CC_DESKTOP`, so this renders nothing and subscribes to nothing.
//
// "elevated" is deliberately silent here — nothing in the engine changes
// behavior at that level yet (packages/core/src/memory-pressure.mjs calls it
// a signal a caller MAY act on), so surfacing it would just be noise. Only
// "critical" — the level at which the engine itself has paused starting new
// indexing passes rather than risk an OOM kill (service.mjs's indexQueue) —
// surfaces as a banner, and it explains itself: indexing is paused, not
// broken, and it resumes on its own once memory pressure drops.
import { useEffect, useState } from 'react'
import { C, css } from '../theme'

/** The engine's own memory-pressure verdict (memory-pressure.mjs). */
export type EngineMemory = { level: 'normal' | 'elevated' | 'critical' }

export function EngineMemoryBanner() {
  const [state, setState] = useState<EngineMemory | null>(null)

  useEffect(() => window.__CC_DESKTOP?.engine?.onMemory?.((next) => setState(next)), [])

  if (state?.level !== 'critical') return null

  return (
    <div
      role="status"
      style={css(`display:flex; align-items:center; gap:10px; padding:8px 16px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; font-size:12px; color:${C.amberText};`)}
    >
      <span aria-hidden="true">⚠</span>
      <span style={css('flex:1 1 auto; min-width:0; overflow-wrap:anywhere;')}>
        The engine is low on memory and has paused starting new indexing passes. Anything already
        indexed stays readable — this clears on its own once memory frees up.
      </span>
    </div>
  )
}
