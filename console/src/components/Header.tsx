import { css } from '../theme'
import { useStore } from '../store'
import { ThemeToggle } from './ThemeToggle'

const TITLES: Record<string, [string, string]> = {
  canvas: ['Canvas', 'Your knowledge cascade, spatially — pan, zoom, resolve'],
  overview: ['Overview', 'How your context is resolving right now'],
  triage: ['Triage', 'Decide what becomes shared knowledge'],
  conflicts: ['Conflicts', 'Where layers disagree — and how to resolve'],
  concepts: ['Concepts', 'Browse the resolved cascade with provenance'],
}

export function Header() {
  const { view, query, setQuery } = useStore()
  const [title, sub] = TITLES[view]
  const showSearch = view === 'triage' || view === 'concepts'
  const placeholder = view === 'concepts' ? 'Search concepts…' : 'Filter signals…'

  return (
    <header style={css('position:sticky; top:0; z-index:6; display:flex; align-items:center; gap:16px; height:66px; padding:0 26px; background:rgba(241,240,234,0.82); backdrop-filter:blur(10px); border-bottom:1px solid #D8D6CC;')}>
      <div style={{ lineHeight: 1.2 }}>
        <div style={css('font-size:17px; font-weight:600; letter-spacing:-0.01em;')}>{title}</div>
        <div style={css('font-size:12px; color:#57564F;')}>{sub}</div>
      </div>
      <div style={css('margin-left:auto; display:flex; align-items:center; gap:10px;')}>
        {showSearch && (
          <label style={css('display:flex; align-items:center; gap:8px; height:38px; padding:0 12px; background:#FBFAF6; border:1px solid #C3C1B8; border-radius:9px;')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--cc-faint)' }} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              style={css("border:none; background:transparent; outline:none; font:inherit; font-size:13px; width:200px; color:#1A1915;")}
            />
          </label>
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}
