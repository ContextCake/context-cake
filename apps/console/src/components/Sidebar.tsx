import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStore, type ViewId } from '../store'
import { UpdatePill } from './UpdatePill'
import contextCakeLogo from '../../../desktop/build/icon.svg'

const SIDEBAR_PREF_KEY = 'contextcake.sidebar'
const COLLAPSED_WIDTH = 72
const MIN_EXPANDED_WIDTH = 188
const DEFAULT_WIDTH = 244
const MAX_WIDTH = 360
const COLLAPSE_THRESHOLD = 136

type SidebarPreference = { collapsed: boolean; width: number }

const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_EXPANDED_WIDTH, width))

function readSidebarPreference(): SidebarPreference {
  if (typeof window === 'undefined') return { collapsed: false, width: DEFAULT_WIDTH }
  try {
    const value = JSON.parse(window.localStorage.getItem(SIDEBAR_PREF_KEY) ?? '{}') as Partial<SidebarPreference>
    return {
      collapsed: value.collapsed === true,
      width: typeof value.width === 'number' && Number.isFinite(value.width) ? clampWidth(value.width) : DEFAULT_WIDTH,
    }
  } catch {
    return { collapsed: false, width: DEFAULT_WIDTH }
  }
}

const NAV: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  {
    id: 'canvas',
    label: 'Canvas',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="7" height="6" rx="1.6" /><rect x="14" y="8" width="7" height="6" rx="1.6" /><rect x="7" y="15" width="7" height="5" rx="1.6" /></svg>,
  },
  {
    id: 'overview',
    label: 'Overview',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  },
  {
    id: 'triage',
    label: 'Queue',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h10" /></svg>,
  },
  {
    id: 'conflicts',
    label: 'Resolve',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="12" r="2.4" /><path d="M8.2 6h4.2a3 3 0 0 1 3 3v.6M8.2 18h4.2a3 3 0 0 0 3-3v-.6" /></svg>,
  },
  {
    id: 'concepts',
    label: 'Concepts',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="17" r="2.2" /><path d="M7.6 8.6 10.6 15M16.4 7.7 13 15.4M8 7h7.8" /></svg>,
  },
]

/**
 * Left navigation sidebar: brand, vertical nav, and a pinned foot of utilities
 * (setup, Ask, settings). On mobile it becomes an off-canvas
 * drawer — `onNavigate` lets the shell close it after a nav choice.
 */
export function Sidebar({
  onReopenSetup,
  onConnectAgent,
  onOpenSettings,
  onNavigate,
}: {
  onReopenSetup?: () => void
  onConnectAgent?: () => void
  onOpenSettings?: () => void
  onNavigate?: () => void
}) {
  const { view, setView, openChat, signals, conflicts, mode } = useStore()
  const [sidebar, setSidebar] = useState(readSidebarPreference)
  const [resizing, setResizing] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  const desktop = Boolean(window.__CC_DESKTOP)
  const triageCount = signals.filter((s) => s.route === 'review_required').length
  const openConflicts = conflicts.filter((c) => c.status === 'open').length
  const badgeFor = (id: ViewId) => (id === 'triage' ? triageCount : id === 'conflicts' ? openConflicts : 0)

  const go = (id: ViewId) => { setView(id); onNavigate?.() }

  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_PREF_KEY, JSON.stringify(sidebar)) } catch { /* local persistence is optional */ }
  }, [sidebar])

  useEffect(() => () => resizeCleanup.current?.(), [])

  const toggleCollapsed = () => setSidebar((current) => ({ ...current, collapsed: !current.collapsed }))
  const setWidthFromDrag = (width: number) => {
    setSidebar((current) => width < COLLAPSE_THRESHOLD
      ? { ...current, collapsed: true }
      : { collapsed: false, width: clampWidth(width) })
  }
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    resizeCleanup.current?.()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = sidebar.collapsed ? COLLAPSED_WIDTH : sidebar.width
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setResizing(true)

    const move = (moveEvent: PointerEvent) => {
      if (Number.isInteger(pointerId) && moveEvent.pointerId !== pointerId) return
      setWidthFromDrag(startWidth + moveEvent.clientX - startX)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)
      handle.removeEventListener('lostpointercapture', cleanup)
      if (Number.isInteger(pointerId) && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setResizing(false)
      resizeCleanup.current = null
    }
    resizeCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('blur', cleanup)
    handle.addEventListener('lostpointercapture', cleanup)
    if (Number.isInteger(pointerId)) handle.setPointerCapture(pointerId)
  }
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault()
      setSidebar((current) => ({ ...current, collapsed: true }))
    } else if (event.key === 'End') {
      event.preventDefault()
      setSidebar({ collapsed: false, width: MAX_WIDTH })
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebar((current) => {
        if (current.collapsed || current.width - 16 < MIN_EXPANDED_WIDTH) return { ...current, collapsed: true }
        return { collapsed: false, width: current.width - 16 }
      })
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebar((current) => ({ collapsed: false, width: current.collapsed ? current.width : clampWidth(current.width + 16) }))
    }
  }

  const displayedWidth = sidebar.collapsed ? COLLAPSED_WIDTH : sidebar.width
  const actionTitle = (label: string) => sidebar.collapsed ? label : undefined

  return (
    <aside
      className="cc-sidebar"
      data-collapsed={sidebar.collapsed ? 'true' : 'false'}
      data-resizing={resizing ? 'true' : 'false'}
      style={{ width: displayedWidth } as CSSProperties}
    >
      <div className="cc-brand">
        <img className="cc-brand-logo" src={contextCakeLogo} alt="ContextCake" />
      </div>
      <button
        type="button"
        className="cc-sidebar-toggle"
        onClick={toggleCollapsed}
        aria-label={sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={sidebar.collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} /></svg>
      </button>
      <div
        className="cc-sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={COLLAPSED_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={displayedWidth}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      ><span aria-hidden="true" /></div>

      <nav className="cc-nav" aria-label="Explore navigation">
        {NAV.map((item) => {
          const badge = badgeFor(item.id)
          const accessibleLabel = badge > 0
            ? `${item.label}, ${badge} ${item.id === 'triage' ? 'items awaiting review' : 'open conflicts'}`
            : item.label
          return (
            <button
              key={item.id}
              className="cc-nav-button"
              onClick={() => go(item.id)}
              aria-current={view === item.id ? 'true' : undefined}
              aria-label={sidebar.collapsed ? accessibleLabel : undefined}
              data-view={item.id}
              title={actionTitle(item.label)}
            >
              {item.icon}
              <span className="cc-nav-label">{item.label}</span>
              {badge > 0 && <span className="cc-nav-badge">{badge}</span>}
            </button>
          )
        })}
      </nav>

      <div className="cc-sidebar-foot">
        {onReopenSetup && (
          <button type="button" className="cc-setup-cta" onClick={onReopenSetup} aria-label={sidebar.collapsed ? 'Finish setup' : undefined} title={actionTitle('Finish setup')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7" /></svg>
            <span className="cc-sidebar-action-label">Finish setup</span>
          </button>
        )}
        {onConnectAgent && (
          <button type="button" className="cc-connect-cta" onClick={onConnectAgent} aria-label={sidebar.collapsed ? 'Connect an agent' : undefined} title={actionTitle('Connect an agent')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 12h8M12 8v8" /><rect x="3" y="4" width="18" height="16" rx="3" /></svg>
            <span className="cc-sidebar-action-label">Connect an agent</span>
          </button>
        )}
        <button className="cc-ask-button" onClick={openChat} aria-label={sidebar.collapsed ? 'Ask ContextCake' : undefined} title={actionTitle('Ask ContextCake')}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /></svg>
          <span className="cc-sidebar-action-label">Ask ContextCake</span>
        </button>
        <UpdatePill mode={mode} />
        {mode === 'live' && !desktop && (
          <a className="cc-configure-link" href="/" aria-label={sidebar.collapsed ? 'Configure sources' : undefined} title={actionTitle('Configure sources')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
            <span className="cc-sidebar-action-label">Configure sources</span>
          </a>
        )}
        {onOpenSettings && (
          <button type="button" className="cc-settings-cta" onClick={onOpenSettings} aria-label={sidebar.collapsed ? 'Settings' : undefined} title={actionTitle('Settings')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </button>
        )}
      </div>
    </aside>
  )
}
