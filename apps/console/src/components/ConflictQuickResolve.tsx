// The Cascade view's inline conflict resolution: a lightweight popover
// anchored to the conflict badge/ghost card that was clicked, offering the
// two safe, one-click dispositions (use one contributor's answer everywhere,
// or acknowledge the difference) without leaving the canvas. It deliberately
// does NOT duplicate the full resolver (Conflicts.tsx's DecisionPanel) — the
// "write a reconciled answer" disposition needs a diff view and a compose
// field that don't fit a popover — "Open full resolver" hands off to that.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Conflict } from '../data'
import type { AcknowledgementReason } from '../types'
import { reasonOptionsFor } from '../conflict-reasons'
import { useStoreData } from '../store'

const POPOVER_W = 320

export function ConflictQuickResolve({
  conflict, anchorEl, onClose, onOpenFullResolver,
}: {
  conflict: Conflict
  anchorEl: HTMLElement
  onClose: () => void
  onOpenFullResolver: () => void
}) {
  const { decideDiscrepancy, resolvingConflict, resolutionError } = useStoreData()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const [showAcknowledge, setShowAcknowledge] = useState(false)
  const [reasonCode, setReasonCode] = useState<AcknowledgementReason | ''>('')
  const [note, setNote] = useState('')
  const [attempted, setAttempted] = useState(false)
  const busy = resolvingConflict === conflict.id
  // Broken links require a source edit — the same disqualifier DecisionPanel
  // uses for "use this answer everywhere" / "write a reconciled answer".
  const cannotWrite = conflict.kind === 'broken_link'
  const reasonOptions = reasonOptionsFor(conflict.kind)

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorEl.getBoundingClientRect()
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - POPOVER_W - 8)
      // First pass, before the popover has a real height to measure: assume
      // it goes below the anchor. The second effect below flips it above
      // once it knows the actual height — needed for a ghost card or badge
      // near the bottom of the canvas, where "below" would run off-screen.
      setAnchor({ top: rect.bottom + 8, left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorEl])

  // Flip above the anchor (or clamp to the viewport) once the popover is in
  // the DOM and its real height is known. Converges in one correction: the
  // flipped position always satisfies "fits below its own top", so the
  // second run through this effect finds nothing left to adjust.
  useLayoutEffect(() => {
    if (!anchor || !popoverRef.current) return
    const popH = popoverRef.current.offsetHeight
    if (anchor.top + popH <= window.innerHeight - 8) return
    const rect = anchorEl.getBoundingClientRect()
    const flippedTop = rect.top - popH - 8
    const nextTop = flippedTop >= 8 ? flippedTop : Math.max(8, window.innerHeight - popH - 8)
    if (nextTop !== anchor.top) setAnchor((a) => (a ? { ...a, top: nextTop } : a))
  }, [anchor, anchorEl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      onClose()
    }
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target) || anchorEl.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [anchorEl, onClose])

  const useAnswer = async (sourceLayer: string) => {
    if (!conflict.revision || busy) return
    setAttempted(true)
    try {
      await decideDiscrepancy({ discrepancyId: conflict.id, revision: conflict.revision, action: 'choose_contribution', selectedSource: sourceLayer })
      onClose()
    } catch { /* resolutionError renders below; stay open so the user can retry or bail to the full resolver */ }
  }

  const acknowledge = async () => {
    if (!conflict.revision || !reasonCode || busy) return
    setAttempted(true)
    try {
      await decideDiscrepancy({ discrepancyId: conflict.id, revision: conflict.revision, action: 'acknowledge', reasonCode, note })
      onClose()
    } catch { /* resolutionError renders below; stay open */ }
  }

  const acknowledgeMissingTarget = async () => {
    if (!conflict.revision || busy) return
    setAttempted(true)
    try {
      await decideDiscrepancy({
        discrepancyId: conflict.id,
        revision: conflict.revision,
        action: 'acknowledge',
        reasonCode: 'target_missing',
        note: '',
      })
      onClose()
    } catch { /* resolutionError renders below; stay open */ }
  }

  if (!anchor) return null

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Resolve — ${conflict.title}`}
      className="cc-conflict-popover"
      style={{ top: anchor.top, left: anchor.left, width: POPOVER_W }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cc-conflict-popover-head">
        <strong>{conflict.title}</strong>
        <span>{conflict.section}</span>
      </div>
      {attempted && resolutionError && <p className="cc-conflict-popover-error" role="alert">{resolutionError.message}</p>}
      {cannotWrite ? (
        <div className="cc-conflict-popover-broken-link">
          <p className="cc-conflict-popover-note">Keep the link without changing files. ContextCake will record <strong>Target not created yet</strong> and recheck when sources change.</p>
          <button type="button" disabled={busy} onClick={() => void acknowledgeMissingTarget()}>{busy ? 'Applying…' : 'Acknowledge for now'}</button>
        </div>
      ) : (
        <div className="cc-conflict-popover-choices">
          {conflict.contributions.map((c) => (
            <button key={c.sourceLayer} type="button" disabled={busy} onClick={() => void useAnswer(c.sourceLayer)}>
              <span>Use {c.sourceLayer}&rsquo;s answer everywhere</span>
              <code>{c.value.length > 64 ? `${c.value.slice(0, 64)}…` : c.value}</code>
            </button>
          ))}
        </div>
      )}
      {!cannotWrite && (!showAcknowledge ? (
        <button type="button" className="cc-conflict-popover-secondary" disabled={busy} onClick={() => setShowAcknowledge(true)}>Keep both — acknowledge</button>
      ) : (
        <div className="cc-conflict-popover-acknowledge">
          <select aria-label="Acknowledgement reason" value={reasonCode} disabled={busy} onChange={(e) => setReasonCode(e.target.value as AcknowledgementReason)}>
            <option value="">Choose a required reason…</option>
            {reasonOptions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <textarea aria-label="Optional local note" placeholder="Optional local note (never learned into a rule)" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button type="button" disabled={busy || !reasonCode} onClick={() => void acknowledge()}>{busy ? 'Applying…' : 'Acknowledge difference'}</button>
        </div>
      ))}
      <button type="button" className="cc-conflict-popover-full" onClick={onOpenFullResolver}>Open full resolver →</button>
    </div>
  )
}
