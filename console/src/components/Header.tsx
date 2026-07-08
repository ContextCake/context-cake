import { useStore, type ViewId } from '../store'

const TITLES: Record<ViewId, [string, string]> = {
  canvas: ['Live cascade', 'Effective knowledge by layer, with conflicts and overrides visible.'],
  overview: ['Cascade health', 'Source coverage, sync state, and decisions that need attention.'],
  triage: ['Review queue', 'Decide what becomes shared knowledge. S stores, R keeps review, D discards.'],
  conflicts: ['Resolver', 'Compare layer values and lock the effective read.'],
  concepts: ['Resolved knowledge', 'Browse concepts, sections, and provenance across the cascade.'],
}

/** Content-column header: a mobile menu button, the view title, search, and
 *  glanceable status pills. Primary nav + utilities live in the Sidebar. */
export function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { view, query, setQuery, signals, conflicts, sources } = useStore()
  const [title, sub] = TITLES[view]
  const showSearch = view === 'triage' || view === 'concepts'
  const placeholder = view === 'concepts' ? 'Search concepts, paths, layers' : 'Filter by repo, owner, label'
  const openConflicts = conflicts.filter((c) => c.status === 'open').length
  const reviewSignals = signals.filter((s) => s.route === 'review_required').length

  return (
    <section className="cc-subbar">
      <button className="cc-menu-btn" onClick={onOpenMenu} aria-label="Open navigation" type="button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
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
      </div>
    </section>
  )
}
