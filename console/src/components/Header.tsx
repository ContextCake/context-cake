import { useEffect, useState } from 'react'
import { useStore, type ViewId } from '../store'
import { C, css, MONO } from '../theme'
import {
  checkForUpdate, isUpdateCheckEnabled, setUpdateCheckEnabled, type UpdateInfo,
} from '../update'

const TITLES: Record<ViewId, [string, string]> = {
  canvas: ['Live cascade', 'Effective knowledge by layer, with conflicts and overrides visible.'],
  overview: ['Cascade health', 'Source coverage, sync state, and decisions that need attention.'],
  triage: ['Review queue', 'Decide what becomes shared knowledge. S stores, R keeps review, D discards.'],
  conflicts: ['Resolver', 'Compare layer values and lock the effective read.'],
  concepts: ['Resolved knowledge', 'Browse concepts, sections, and provenance across the cascade.'],
}

/** Non-blocking "update available" pill + a tiny opt-out toggle. Never gates render. */
function UpdatePill({ mode }: { mode: 'demo' | 'live' }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [enabled, setEnabled] = useState(() => isUpdateCheckEnabled(mode))
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!enabled) { setInfo(null); return }
    let cancelled = false
    void checkForUpdate(__APP_VERSION__).then((result) => {
      if (!cancelled) setInfo(result)
    })
    return () => { cancelled = true }
  }, [enabled])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    setUpdateCheckEnabled(next)
    if (!next) { setInfo(null); setDismissed(false) }
  }

  return (
    <div style={css('position:relative; display:flex; align-items:center; gap:6px;')}>
      {enabled && info && !dismissed && (
        <div style={css(`display:inline-flex; align-items:center; gap:6px; padding:4px 6px 4px 10px; border-radius:999px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-family:${MONO}; font-size:11px; color:${C.tealText};`)}>
          <a
            href={info.url}
            target="_blank"
            rel="noopener noreferrer"
            style={css(`color:${C.tealText}; text-decoration:none; font-weight:600;`)}
          >
            Update available &rarr; v{info.latest}
          </a>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update notice"
            title="Dismiss for this session"
            style={css(`display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0; border:none; background:transparent; color:${C.tealText}; cursor:pointer; font-size:12px; line-height:1;`)}
          >&times;</button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Update check settings"
        aria-expanded={menuOpen}
        title="Update check settings"
        style={css(`display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border-radius:999px; border:1px solid ${C.line}; background:${C.surface}; color:${C.caption}; cursor:pointer;`)}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
      </button>
      {menuOpen && (
        <div style={css(`position:absolute; top:28px; right:0; z-index:20; padding:10px 12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.line}; box-shadow:0 8px 24px rgba(0,0,0,0.18); white-space:nowrap;`)}>
          <label style={css(`display:flex; align-items:center; gap:7px; font-size:12px; color:${C.body}; cursor:pointer;`)}>
            <input type="checkbox" checked={enabled} onChange={toggle} />
            Check for updates
          </label>
        </div>
      )}
    </div>
  )
}

export function Header() {
  const { view, query, setQuery, signals, conflicts, sources, mode } = useStore()
  const [title, sub] = TITLES[view]
  const showSearch = view === 'triage' || view === 'concepts'
  const placeholder = view === 'concepts' ? 'Search concepts, paths, layers' : 'Filter by repo, owner, label'
  const openConflicts = conflicts.filter((c) => c.status === 'open').length
  const reviewSignals = signals.filter((s) => s.route === 'review_required').length

  return (
    <section className="cc-subbar">
      <div className="cc-view-title">
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className="cc-sub-actions">
        {showSearch && (
          <label className="cc-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--cc-caption)' }} strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
            />
          </label>
        )}
        <div className="cc-status-pill"><strong>Sources</strong>{sources.length} active</div>
        <div className="cc-status-pill"><strong>Queue</strong>{reviewSignals} review</div>
        <div className="cc-status-pill"><strong>Resolve</strong>{openConflicts} open</div>
        <UpdatePill mode={mode} />
      </div>
    </section>
  )
}
