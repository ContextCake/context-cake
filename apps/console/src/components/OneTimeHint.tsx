// A hint that shows on the first visit to a surface and then never again.
// Dismissed by "Got it", Escape, or the first click anywhere else — whichever
// comes first — and the dismissal is permanent (one-time-hint.ts). Renders
// nothing once seen, so the surface underneath keeps its full height.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { hintSeen, markHintSeen, type HintId } from '../one-time-hint'

export function OneTimeHint({ id, title, children }: { id: HintId; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => !hintSeen(id))
  const ref = useRef<HTMLDivElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)

  const dismiss = useCallback(() => { markHintSeen(id); setOpen(false) }, [id])

  useEffect(() => {
    if (!open) return
    // Take focus so the hint is dismissible from the keyboard and lands under
    // a screen reader; the next Tab or click leaves it either way.
    dismissRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      dismiss()
    }
    const onPointer = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [open, dismiss])

  if (!open) return null

  return (
    <div ref={ref} className="cc-hint-popover" role="dialog" aria-label={title}>
      <strong>{title}</strong>
      {children}
      <button ref={dismissRef} type="button" onClick={dismiss}>Got it</button>
    </div>
  )
}
