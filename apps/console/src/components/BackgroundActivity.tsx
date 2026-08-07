// The shell's background-work affordance — one compact control in the toolbar,
// visible from every destination.
//
// The doctrine it implements: long-running work is fine, a busy or lying UI is
// not. A user can add a 3,000-note vault, watch it fill from here, and go
// browse concepts while it does. What the engine is doing is always legible
// without leaving the view you are in, and a background refresh that has
// started failing says so here instead of quietly freezing the page.
//
// Two states the engine distinguishes and so does this: a source that is
// *indexing* has nothing to serve yet (progress, a moving ring); a source that
// is *refreshing* is already serving good data and re-reading behind it (a
// quiet note, never a spinner in front of an answer).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { progressPercent } from '../api'
import { useStore } from '../store'
import type { BackgroundTask } from '../store'
import { C, css, MONO } from '../theme'

const NUM = new Intl.NumberFormat()

/** The same set App.tsx restores focus across, so the two agree on "a control". */
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const PHASES: Record<string, string> = {
  queued: 'Queued', scanning: 'Scanning', loading: 'Reading', cloning: 'Cloning',
  ready: 'Ready', error: 'Failed',
}

/** "1m 04s" / "12s" — a wall clock, so a stuck source is visibly stuck. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

/** Aggregate percent across the tasks that have a denominator; null if none do. */
export function aggregatePercent(tasks: BackgroundTask[]): number | null {
  const measured = tasks.filter((t) => t.total != null && t.total > 0)
  if (measured.length === 0) return null
  const loaded = measured.reduce((n, t) => n + t.loaded, 0)
  const total = measured.reduce((n, t) => n + (t.total ?? 0), 0)
  return total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : null
}

/** The toolbar label. Compact by design — the detail lives in the popover. */
export function activityLabel(tasks: BackgroundTask[], failing: boolean): string {
  if (failing && tasks.length === 0) return 'Reconnecting'
  const indexing = tasks.filter((t) => !t.refreshing)
  const percent = aggregatePercent(indexing.length ? indexing : tasks)
  if (indexing.length === 0) return tasks.length > 1 ? `Refreshing ${tasks.length}` : 'Refreshing'
  const scope = indexing.length > 1 ? `Indexing ${indexing.length} sources` : 'Indexing'
  return percent == null ? scope : `${scope} · ${percent}%`
}

/** The sentence a screen reader hears, which the visual label abbreviates. */
export function activityDescription(tasks: BackgroundTask[], failing: boolean): string {
  const parts = tasks.map((t) => {
    const counts = t.total != null && t.total > 0
      ? `${NUM.format(t.loaded)} of ${NUM.format(t.total)}`
      : `${NUM.format(t.loaded)} so far`
    return t.refreshing
      ? `${t.name} refreshing in the background`
      : `${t.name} ${(PHASES[t.phase] ?? 'indexing').toLowerCase()}, ${counts}`
  })
  const work = parts.length ? `Background activity: ${parts.join('; ')}.` : ''
  return failing ? `${work} Live refresh is failing and retrying.`.trim() : work
}

/** A 15px ring: determinate when the engine has a denominator, sweeping when not. */
function Ring({ percent, tone }: { percent: number | null; tone: 'work' | 'attention' }) {
  const stroke = tone === 'attention' ? C.amberStrokeE : C.tealStroke
  const R = 6
  const circumference = 2 * Math.PI * R
  // An unknown total sweeps a quarter arc rather than inventing a fraction.
  const dash = percent == null ? circumference * 0.25 : (circumference * percent) / 100
  return (
    <svg
      className={percent == null ? 'cc-activity-ring cc-activity-ring--sweep' : 'cc-activity-ring'}
      width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"
    >
      <circle cx="8" cy="8" r={R} fill="none" stroke={C.track} strokeWidth="2.5" />
      <circle
        cx="8" cy="8" r={R} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference}`} transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

function TaskRow({ task }: { task: BackgroundTask }) {
  const percent = progressPercent(task)
  const counts = task.total != null && task.total > 0
    ? `${NUM.format(task.loaded)} / ${NUM.format(task.total)}`
    : NUM.format(task.loaded)
  const label = task.refreshing ? 'Refreshing' : (PHASES[task.phase] ?? 'Indexing')
  return (
    <li style={css('display:flex; flex-direction:column; gap:6px;')}>
      <div style={css('display:flex; align-items:baseline; justify-content:space-between; gap:10px;')}>
        <span style={css(`font-family:${MONO}; font-size:12px; font-weight:600; color:${C.ink}; overflow-wrap:anywhere;`)}>{task.name}</span>
        <span style={css(`flex:0 0 auto; font-size:11px; color:${C.faint};`)}>{formatElapsed(task.elapsedMs)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${task.name} ${label.toLowerCase()}`}
        aria-valuetext={percent == null ? `${counts} read` : `${percent}%, ${counts}`}
        {...(percent == null ? {} : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
        style={css(`height:4px; border-radius:999px; background:${C.track}; overflow:hidden;`)}
      >
        <div style={css(`height:100%; width:${percent ?? 30}%; border-radius:999px; background:${task.refreshing ? C.blueStroke : C.tealStroke}; transition:width 220ms var(--cc-ease-out);`)} />
      </div>
      <div style={css(`display:flex; gap:6px; font-size:11.5px; color:${C.caption};`)}>
        <span>{label}</span><span aria-hidden="true">·</span><span>{counts}</span>
        <span aria-hidden="true">·</span><span>{task.kind}</span>
      </div>
    </li>
  )
}

export function BackgroundActivity() {
  const { load, retryNow, setView } = useStore()
  const { tasks, refreshError, lastRefreshAt } = load
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const failing = refreshError != null
  const idle = tasks.length === 0 && !failing

  const close = useCallback(() => {
    setOpen(false)
    // Focus returns to the control that opened it — a popover must not strand
    // keyboard focus at the end of the document.
    window.requestAnimationFrame(() => buttonRef.current?.focus())
  }, [])

  // Work finishing takes this control out of the toolbar, and React removes the
  // DOM node in the same commit as the render that returns null. A focused node
  // removed that way drops focus to <body> — a keyboard user who was standing
  // on this button, or inside its popover, lands back at the top of the
  // document with no idea why. So retire in two steps: notice `idle`, hand
  // focus to the next control in the toolbar, and only then unmount. Both steps
  // are in a layout effect, so the extra commit never reaches the screen.
  //
  // `everMounted` keeps the ordinary case free: an app with no background work
  // has never rendered this control and still renders nothing at all.
  const everMounted = useRef(false)
  const [retired, setRetired] = useState(true)

  useLayoutEffect(() => {
    if (!idle) { everMounted.current = true; setRetired(false); return }
    if (!everMounted.current || retired) return
    const button = buttonRef.current
    const holdsFocus = button?.contains(document.activeElement) === true
      || popoverRef.current?.contains(document.activeElement) === true
    if (holdsFocus && button) {
      const toolbar = button.parentElement
      const candidates = [...(toolbar?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !button.contains(el))
      const after = candidates.filter((el) => button.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      const target = after[0] ?? candidates[candidates.length - 1] ?? button.closest<HTMLElement>('header')
      // A header is a landmark, not a control — make it focusable only for the
      // moment it has to catch focus that has nowhere better to go.
      if (target && target.tagName === 'HEADER') target.tabIndex = -1
      target?.focus()
    }
    setOpen(false)
    setRetired(true)
    everMounted.current = false
  }, [idle, retired])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [close, open])

  if (idle && retired) return null

  const percent = aggregatePercent(tasks.filter((t) => !t.refreshing)) ?? aggregatePercent(tasks)
  const label = activityLabel(tasks, failing)
  const description = activityDescription(tasks, failing)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cc-activity"
        data-tone={failing ? 'attention' : 'work'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={description || label}
        title={description || label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Ring percent={failing && tasks.length === 0 ? null : percent} tone={failing ? 'attention' : 'work'} />
        <span className="cc-activity-label">{label}</span>
      </button>
      {open && anchor && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Background activity"
          className="cc-activity-popover"
          style={{ top: anchor.top, right: anchor.right }}
        >
          <div style={css(`display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:2px;`)}>
            <strong style={css(`font-size:12.5px; color:${C.ink};`)}>Background activity</strong>
            {lastRefreshAt != null && (
              <span style={css(`font-size:11px; color:${C.faint};`)}>
                updated {new Date(lastRefreshAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          {failing && (
            <div role="status" style={css(`display:flex; flex-direction:column; gap:8px; padding:9px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
              <span>Live refresh is failing — retrying. You are seeing the last good data. {refreshError?.message}</span>
              <button type="button" className="cc-activity-action" onClick={() => { retryNow(); close() }}>Retry now</button>
            </div>
          )}
          {tasks.length > 0 ? (
            <ul style={css('margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:14px;')}>
              {tasks.map((task) => <TaskRow key={task.name} task={task} />)}
            </ul>
          ) : (
            <p style={css(`margin:0; font-size:12px; line-height:1.5; color:${C.caption};`)}>
              No indexing in flight. The page is still live — it just cannot reach the engine right now.
            </p>
          )}
          <button
            type="button"
            className="cc-activity-action"
            onClick={() => { setView('sources'); close() }}
          >Open Sources</button>
        </div>
      )}
    </>
  )
}
