import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStore } from '../store'
import { destinationForView, readBrowserGroupedViews, viewForDestination, type ShellDestination } from '../shell-navigation'
import { CascadeIcon, HomeIcon, KnowledgeIcon, ReviewIcon, SettingsIcon, SourcesIcon } from './icons'

const contextCakeLogo = `${import.meta.env.BASE_URL}favicon.svg`
const BROWSER_KEY = 'contextcake.sidebar'
const COLLAPSED_WIDTH = 64
const MIN_WIDTH = 208
const DEFAULT_WIDTH = 232
const MAX_WIDTH = 300

type SidebarPreference = { collapsed: boolean; width: number }
const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))

function readPreference(): SidebarPreference {
  const desktop = window.__CC_DESKTOP?.uiState?.initial.sidebar
  if (desktop) return { collapsed: desktop.collapsed === true, width: clampWidth(desktop.width) }
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_KEY) ?? '{}') as Partial<SidebarPreference>
    return { collapsed: value.collapsed === true, width: Number.isFinite(value.width) ? clampWidth(value.width!) : DEFAULT_WIDTH }
  } catch { return { collapsed: false, width: DEFAULT_WIDTH } }
}

const NAV: Array<{ id: ShellDestination; label: string; icon: ReactNode }> = [
  { id: 'home', label: 'Home', icon: <HomeIcon /> },
  { id: 'cascade', label: 'Cascade', icon: <CascadeIcon /> },
  { id: 'knowledge', label: 'Knowledge', icon: <KnowledgeIcon /> },
  { id: 'sources', label: 'Sources', icon: <SourcesIcon /> },
  { id: 'review', label: 'Review', icon: <ReviewIcon /> },
]

export function Sidebar({ onOpenSettings, onNavigate }: { onOpenSettings?: () => void; onNavigate?: () => void }) {
  const { view, setView, signals, conflicts, sources } = useStore()
  const [sidebar, setSidebar] = useState(readPreference)
  const [resizing, setResizing] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  const browserViews = useRef(readBrowserGroupedViews())
  const knowledgeView = useRef(window.__CC_DESKTOP?.uiState?.initial.knowledgeView ?? browserViews.current.knowledgeView)
  const reviewView = useRef(window.__CC_DESKTOP?.uiState?.initial.reviewView ?? browserViews.current.reviewView)
  if (view === 'concepts' || view === 'files') knowledgeView.current = view
  if (view === 'triage' || view === 'conflicts') reviewView.current = view

  const reviewCount = signals.filter((signal) => signal.route === 'review_required').length
    + conflicts.filter((conflict) => conflict.status === 'open').length
  const sourceErrors = sources.filter((source) => source.status === 'degraded' || source.status === 'error').length

  const go = (destination: ShellDestination) => {
    setView(viewForDestination(destination, knowledgeView.current, reviewView.current))
    onNavigate?.()
  }

  useEffect(() => {
    window.__CC_DESKTOP?.uiState?.set({ sidebar }).catch(() => {})
    if (!window.__CC_DESKTOP) {
      try { localStorage.setItem(BROWSER_KEY, JSON.stringify(sidebar)) } catch { /* optional */ }
    }
  }, [sidebar])

  useEffect(() => {
    const toggle = () => setSidebar((current) => ({ ...current, collapsed: !current.collapsed }))
    window.addEventListener('contextcake:toggle-sidebar', toggle)
    return () => window.removeEventListener('contextcake:toggle-sidebar', toggle)
  }, [])

  useEffect(() => () => resizeCleanup.current?.(), [])

  const setWidthFromDrag = (width: number) => setSidebar((current) => width < MIN_WIDTH - 24
    ? { ...current, collapsed: true }
    : { collapsed: false, width: clampWidth(width) })

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
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -8 : 8
      setSidebar((current) => {
        if (current.collapsed && direction > 0) return { collapsed: false, width: current.width }
        const width = current.width + direction
        return width < MIN_WIDTH ? { ...current, collapsed: true } : { collapsed: false, width: clampWidth(width) }
      })
    }
  }

  const displayedWidth = sidebar.collapsed ? COLLAPSED_WIDTH : sidebar.width
  const destination = destinationForView(view)

  return (
    <aside className="cc-sidebar" data-collapsed={sidebar.collapsed} data-resizing={resizing} style={{ width: displayedWidth } as CSSProperties}>
      <div className="cc-brand">
        <img className="cc-brand-logo" src={contextCakeLogo} alt="" />
        <span className="cc-brand-name">ContextCake</span>
      </div>
      <div
        className="cc-sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical"
        aria-valuemin={COLLAPSED_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={displayedWidth} tabIndex={0}
        onPointerDown={beginResize} onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => setSidebar({ collapsed: false, width: DEFAULT_WIDTH })}
      ><span aria-hidden="true" /></div>
      <nav className="cc-nav" aria-label="Main navigation">
        {NAV.map((item) => {
          const badge = item.id === 'review' ? reviewCount : item.id === 'sources' ? sourceErrors : 0
          const suffix = item.id === 'review' ? 'items needing review' : 'source errors'
          return <button
            key={item.id} type="button" className="cc-nav-button" data-destination={item.id}
            aria-current={destination === item.id ? 'page' : undefined}
            aria-label={sidebar.collapsed ? `${item.label}${badge ? `, ${badge} ${suffix}` : ''}` : undefined}
            title={sidebar.collapsed ? item.label : undefined} onClick={() => go(item.id)}
          >
            {item.icon}<span className="cc-nav-label">{item.label}</span>
            {badge > 0 && <span className={`cc-nav-badge ${item.id === 'sources' ? 'is-error' : ''}`}>{badge}</span>}
          </button>
        })}
      </nav>
      <div className="cc-sidebar-foot">
        <button type="button" className="cc-settings-cta" onClick={onOpenSettings} aria-label={sidebar.collapsed ? 'Settings' : undefined} title={sidebar.collapsed ? 'Settings' : undefined}>
          <SettingsIcon /><span>Settings</span><kbd>⌘,</kbd>
        </button>
      </div>
    </aside>
  )
}
