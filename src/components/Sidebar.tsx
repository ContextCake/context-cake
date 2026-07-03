import { C, css, MONO } from '../theme'
import { useStore, type ViewId } from '../store'

function navStyle(active: boolean): React.CSSProperties {
  return css(`display:flex; align-items:center; gap:11px; width:100%; border:1px solid ${active ? C.blueFill3 : 'transparent'}; background:${active ? C.blueFill : 'transparent'}; border-radius:9px; padding:9px 12px; color:${active ? C.blueText : C.body}; font:inherit; font-weight:${active ? 600 : 500}; font-size:13.5px; text-align:left; cursor:pointer;`)
}

const badgeBase = (strong: boolean): React.CSSProperties =>
  css(`margin-left:auto; font-family:${MONO}; font-size:11px; font-weight:600; min-width:20px; text-align:center; padding:1px 6px; border-radius:999px; background:${C.amberFill}; color:${C.amberText}; border:1px solid ${strong ? C.amberStroke : C.amberSoft};`)

function NavItem({ id, active, label, badge, onClick, children }: {
  id: ViewId; active: boolean; label: string; badge?: { value: number; strong: boolean }
  onClick: () => void; children: React.ReactNode
}) {
  return (
    <button className="cc-h-navbg" onClick={onClick} style={navStyle(active)} aria-current={active} data-view={id}>
      {children}
      <span>{label}</span>
      {badge && badge.value > 0 && <span style={badgeBase(badge.strong)}>{badge.value}</span>}
    </button>
  )
}

export function Sidebar() {
  const { view, setView, openChat, signals, conflicts } = useStore()
  const triageCount = signals.filter((s) => s.route === 'review_required').length
  const openConflicts = conflicts.filter((c) => c.status === 'open').length

  return (
    <aside style={css('position:sticky; top:0; height:100vh; width:242px; flex:0 0 242px; display:flex; flex-direction:column; background:#FBFAF6; border-right:1px solid #D8D6CC;')}>
      <div style={css('display:flex; align-items:center; gap:11px; padding:20px 18px 18px;')}>
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
          <rect x="4" y="18.5" width="22" height="6.5" rx="2.2" fill="#EAF3FC" stroke="#3D7AB8" strokeWidth="1.6" />
          <rect x="6" y="11.5" width="18" height="6.2" rx="2.2" fill="#D9EAFB" stroke="#2F6DA8" strokeWidth="1.6" />
          <rect x="8.5" y="4.8" width="13" height="6" rx="2.2" fill="#FBF0DD" stroke="#C77D2A" strokeWidth="1.6" />
        </svg>
        <div style={{ lineHeight: 1.15 }}>
          <div style={css('font-weight:600; font-size:15px; letter-spacing:-0.01em;')}>ContextCake</div>
          <div style={css('font-size:10.5px; font-weight:500; letter-spacing:0.08em; text-transform:uppercase; color:#8A8A82;')}>Context Console</div>
        </div>
      </div>

      <nav style={css('display:flex; flex-direction:column; gap:3px; padding:6px 12px; flex:1;')}>
        <NavItem id="canvas" active={view === 'canvas'} label="Canvas" onClick={() => setView('canvas')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="7" height="6" rx="1.6" /><rect x="14" y="8" width="7" height="6" rx="1.6" /><rect x="7" y="15" width="7" height="5" rx="1.6" /><path d="M10 7h4M17.5 14v1M10.5 17H8.5a2 2 0 0 0-2 2" /></svg>
        </NavItem>
        <NavItem id="overview" active={view === 'overview'} label="Overview" onClick={() => setView('overview')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
        </NavItem>
        <NavItem id="triage" active={view === 'triage'} label="Triage" badge={{ value: triageCount, strong: false }} onClick={() => setView('triage')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h10" /></svg>
        </NavItem>
        <NavItem id="conflicts" active={view === 'conflicts'} label="Conflicts" badge={{ value: openConflicts, strong: true }} onClick={() => setView('conflicts')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="12" r="2.4" /><path d="M6 8.4v7.2M8.2 6h4.2a3 3 0 0 1 3 3v.6M8.2 18h4.2a3 3 0 0 0 3-3v-.6" /></svg>
        </NavItem>
        <NavItem id="concepts" active={view === 'concepts'} label="Concepts" onClick={() => setView('concepts')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="17" r="2.2" /><path d="M7.6 8.6 10.6 15M16.4 7.7 13 15.4M8 7h7.8" /></svg>
        </NavItem>
      </nav>

      <div style={css('padding:12px; border-top:1px solid #D8D6CC; display:flex; flex-direction:column; gap:12px;')}>
        <button className="cc-h-tealdark" onClick={openChat} style={css("display:flex; align-items:center; gap:9px; width:100%; border:none; border-radius:9px; background:#1E6B64; color:var(--cc-on-teal); padding:11px 13px; font:inherit; font-weight:500; font-size:13.5px; cursor:pointer;")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>
          <span>Ask ContextCake</span>
        </button>
        <div style={css('display:flex; align-items:center; gap:9px; padding:2px 4px;')}>
          <span style={css('width:8px; height:8px; border-radius:999px; background:#2C8A82; box-shadow:0 0 0 3px #D7F0EC; animation:ccPulse 2.4s ease-in-out infinite; flex:0 0 auto;')} />
          <div style={{ lineHeight: 1.25 }}>
            <div style={css('font-size:11.5px; font-weight:500; color:#134F49;')}>Serving cascade</div>
            <div style={css("font-size:10.5px; color:#8A8A82; font-family:'IBM Plex Mono', monospace;")}>3 layers · 178 concepts</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
