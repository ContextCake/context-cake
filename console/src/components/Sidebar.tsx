import type { ReactNode } from 'react'
import { useStore, type ViewId } from '../store'
import { ThemeToggle } from './ThemeToggle'

const NAV: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  {
    id: 'canvas',
    label: 'Canvas',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="7" height="6" rx="1.6" /><rect x="14" y="8" width="7" height="6" rx="1.6" /><rect x="7" y="15" width="7" height="5" rx="1.6" /></svg>,
  },
  {
    id: 'overview',
    label: 'Overview',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  },
  {
    id: 'triage',
    label: 'Queue',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h10" /></svg>,
  },
  {
    id: 'conflicts',
    label: 'Resolve',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="12" r="2.4" /><path d="M8.2 6h4.2a3 3 0 0 1 3 3v.6M8.2 18h4.2a3 3 0 0 0 3-3v-.6" /></svg>,
  },
  {
    id: 'concepts',
    label: 'Sources',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="17" r="2.2" /><path d="M7.6 8.6 10.6 15M16.4 7.7 13 15.4M8 7h7.8" /></svg>,
  },
]

export function Sidebar() {
  const { view, setView, openChat, signals, conflicts } = useStore()
  const triageCount = signals.filter((s) => s.route === 'review_required').length
  const openConflicts = conflicts.filter((c) => c.status === 'open').length
  const badgeFor = (id: ViewId) => (id === 'triage' ? triageCount : id === 'conflicts' ? openConflicts : 0)

  return (
    <header className="cc-topbar">
      <div className="cc-brand">
        <div className="cc-brand-mark" aria-hidden="true">C</div>
        <div>
          <div className="cc-brand-name">ContextCake</div>
          <div className="cc-brand-meta">Platform / Prod</div>
        </div>
      </div>

      <nav className="cc-nav" aria-label="Primary navigation">
        {NAV.map((item) => {
          const badge = badgeFor(item.id)
          return (
            <button
              key={item.id}
              className="cc-nav-button"
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
              data-view={item.id}
            >
              {item.icon}
              <span>{item.label}</span>
              {badge > 0 && <span className="cc-nav-badge">{badge}</span>}
            </button>
          )
        })}
      </nav>

      <div className="cc-top-actions">
        <div className="cc-status-pill"><span className="cc-status-dot" /><strong>Sync</strong>42s ago</div>
        <div className="cc-status-pill"><span className="cc-status-dot warn" /><strong>Policy</strong>{openConflicts} pending</div>
        <button className="cc-ask-button" onClick={openChat}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /></svg>
          Ask
        </button>
        <ThemeToggle />
      </div>
    </header>
  )
}
