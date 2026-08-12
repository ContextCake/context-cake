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
import type { IndexingActivity, IndexingActivitySource } from '../api'
import { useStoreData } from '../store'
import type { BackgroundTask } from '../store'
import { C, css, MONO } from '../theme'

const NUM = new Intl.NumberFormat()

/** How often the open popover refreshes its detail feed. Closed = never. */
const ACTIVITY_REFRESH_MS = 2000

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

/**
 * The trigger's accessible name — stable by construction.
 *
 * It is built from the SHAPE of the work (how many sources, indexing or
 * refreshing, failing or not) and never from loaded/total/percent/elapsed, so
 * it changes on a transition and not on a tick. It used to be the full ticking
 * description below, regenerated on every 900ms poll: several screen readers
 * re-announce a focused button whose accessible name changes, so a keyboard
 * user standing on this control was read a fresh sentence four times a minute
 * for the length of an index.
 */
export function activityName(tasks: BackgroundTask[], failing: boolean): string {
  const indexing = tasks.filter((t) => !t.refreshing).length
  const refreshing = tasks.length - indexing
  const parts: string[] = []
  if (indexing > 0) parts.push(`indexing ${indexing} source${indexing === 1 ? '' : 's'}`)
  if (refreshing > 0) parts.push(`refreshing ${refreshing} source${refreshing === 1 ? '' : 's'}`)
  if (failing) parts.push('live refresh failing')
  return parts.length ? `Background activity: ${parts.join(', ')}` : 'Background activity'
}

/**
 * The detailed sentence, with the counts in it. This is the `title` — a sighted
 * user's hover detail — never the accessible name, for the reason above.
 */
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

/** "410 docs/s · ~38s left" — present only while the engine is mid-read. */
export function rateLine(detail: IndexingActivitySource | undefined): string | null {
  if (!detail?.rateDocsPerSec) return null
  const rate = `${NUM.format(detail.rateDocsPerSec)} docs/s`
  if (detail.etaMs == null) return rate
  return `${rate} · ~${formatElapsed(detail.etaMs)} left`
}

/** One line per recent pass: "12:31:04 · ok · 3.7s · read 1, carried 499". */
function PassHistory({ detail }: { detail: IndexingActivitySource }) {
  if (detail.lastPasses.length === 0) return null
  return (
    <ul style={css('margin:4px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:3px;')}>
      {detail.lastPasses.slice(-6).reverse().map((p) => (
        <li key={p.startedAt} style={css(`font-family:${MONO}; font-size:10.5px; color:${C.caption};`)}>
          {new Date(p.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {' · '}{p.outcome}{' · '}{formatElapsed(p.durationMs)}
          {p.read != null && ` · read ${NUM.format(p.read)}, carried ${NUM.format(p.carried ?? 0)}`}
          {p.error ? ` · ${p.error}` : ''}
        </li>
      ))}
    </ul>
  )
}

/** The per-source disclosure: history + warning samples, closed by default. */
function TaskDetail({ detail }: { detail: IndexingActivitySource }) {
  const samples = [...detail.skippedSamples.map((rel) => `skipped ${rel}`), ...detail.unreadableSamples.map((rel) => `unreadable ${rel}`)]
  if (detail.lastPasses.length === 0 && detail.warnings.length === 0 && samples.length === 0) return null
  return (
    <details style={css('margin-top:2px;')}>
      <summary style={css(`cursor:pointer; font-size:11px; color:${C.faint}; user-select:none;`)}>Details</summary>
      {detail.warnings.length > 0 && (
        <ul style={css(`margin:4px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:3px; font-size:11px; line-height:1.45; color:${C.amberText};`)}>
          {detail.warnings.map((w) => <li key={w} style={css('overflow-wrap:anywhere;')}>{w}</li>)}
        </ul>
      )}
      {samples.length > 0 && (
        <ul style={css(`margin:4px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:2px; font-family:${MONO}; font-size:10.5px; color:${C.faint};`)}>
          {samples.slice(0, 8).map((s) => <li key={s} style={css('overflow-wrap:anywhere;')}>{s}</li>)}
        </ul>
      )}
      <PassHistory detail={detail} />
    </details>
  )
}

function TaskRow({ task, detail }: { task: BackgroundTask; detail?: IndexingActivitySource }) {
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
      {/*
        A progressbar and deliberately NOT inside a live region: this row is
        re-rendered every 900ms, and a polite region would read the counter out
        on every tick for the whole of an index. The doctrine is App.tsx's —
        announce transitions, not ticks — so a reader takes the number from here
        on request, and the transitions are announced once, above.
      */}
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
        {rateLine(detail) && <><span aria-hidden="true">·</span><span>{rateLine(detail)}</span></>}
      </div>
      {detail && <TaskDetail detail={detail} />}
    </li>
  )
}

export function BackgroundActivity() {
  const { load, retryNow, setView, fetchIndexingActivity, indexingControl, canControlIndexing } = useStoreData()
  const { tasks, refreshError, lastRefreshAt } = load
  const [open, setOpen] = useState(false)

  // The detail feed exists only while someone is looking at it: fetched on
  // open, refreshed on a slow tick, dropped on close. Never joins the
  // steady-state poll — that is the status-polling doctrine.
  const [activityFeed, setActivityFeed] = useState<IndexingActivity | null>(null)
  useEffect(() => {
    // Guarded like source.setActiveSource: several test harnesses stub a
    // partial store, and a popover without the detail feed is still a popover.
    if (!open || typeof fetchIndexingActivity !== 'function') { setActivityFeed(null); return }
    let cancelled = false
    const pull = () => { void fetchIndexingActivity().then((a) => { if (!cancelled) setActivityFeed(a) }) }
    pull()
    const timer = setInterval(pull, ACTIVITY_REFRESH_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [open, fetchIndexingActivity])
  const detailByName = new Map((activityFeed?.sources ?? []).map((s) => [s.name, s]))
  const allPaused = (activityFeed?.paused ?? []).includes('*')
  const [controlBusy, setControlBusy] = useState(false)
  const toggleAll = async () => {
    if (controlBusy) return
    setControlBusy(true)
    try {
      await indexingControl(allPaused ? 'resume' : 'pause')
      const fresh = await fetchIndexingActivity()
      setActivityFeed(fresh)
    } finally {
      setControlBusy(false)
    }
  }
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

  // What this control announces, and what it deliberately leaves alone.
  //
  // App.tsx already announces the aggregate transitions — indexing started,
  // indexing complete, refresh failing, refresh recovered — so repeating any of
  // them here would have a screen reader say each one twice. The gap is a
  // background REFRESH: the engine reports a refreshing source as `ready`, so it
  // never reaches load.indexingSources and nothing announces it at all. A
  // sighted user watches this control appear and fill; a screen-reader user was
  // told nothing whatsoever.
  //
  // Transitions only, never ticks. The counts live on the per-task progressbars,
  // where a reader asks for them instead of being handed them every 900ms.
  const [announcement, setAnnouncement] = useState('')
  const refreshingCount = tasks.filter((t) => t.refreshing).length
  const previousRefreshing = useRef(0)
  useEffect(() => {
    const previous = previousRefreshing.current
    previousRefreshing.current = refreshingCount
    if (refreshingCount > 0 && previous === 0) {
      setAnnouncement(`Refreshing ${refreshingCount} source${refreshingCount === 1 ? '' : 's'} in the background.`)
    } else if (refreshingCount === 0 && previous > 0) {
      setAnnouncement('Background refresh finished.')
    }
  }, [refreshingCount])

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

  const percent = aggregatePercent(tasks.filter((t) => !t.refreshing)) ?? aggregatePercent(tasks)
  const label = activityLabel(tasks, failing)
  const description = activityDescription(tasks, failing)
  const name = activityName(tasks, failing)

  // The live region outlives the control on purpose. A polite region only
  // announces content that changes while it is ALREADY in the document, so one
  // that mounts with its text in place says nothing — and "the work finished"
  // is exactly the transition where this control is on its way out.
  return (
    <>
      <span className="sr-only" role="status">{announcement}</span>
      {!(idle && retired) && (
        <>
          <button
            ref={buttonRef}
            type="button"
            className="cc-activity"
            data-tone={failing ? 'attention' : 'work'}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={name}
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
                  {tasks.map((task) => <TaskRow key={task.name} task={task} detail={detailByName.get(task.name)} />)}
                </ul>
              ) : (
                <p style={css(`margin:0; font-size:12px; line-height:1.5; color:${C.caption};`)}>
                  No indexing in flight. The page is still live — it just cannot reach the engine right now.
                </p>
              )}
              {allPaused && (
                <p role="status" style={css(`margin:0; font-size:11.5px; line-height:1.5; color:${C.amberText};`)}>
                  Indexing is paused. Sources keep serving what they have; nothing new is read until you resume.
                </p>
              )}
              <div style={css('display:flex; gap:8px;')}>
                <button
                  type="button"
                  className="cc-activity-action"
                  onClick={() => { setView('sources'); close() }}
                >Open Sources</button>
                {canControlIndexing && (
                  <button
                    type="button"
                    className="cc-activity-action"
                    disabled={controlBusy}
                    onClick={() => void toggleAll()}
                  >{allPaused ? 'Resume Indexing' : 'Pause Indexing'}</button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
