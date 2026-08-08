import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStoreData, useStoreNav } from '../store'
import { destinationForView, readBrowserGroupedViews, viewForDestination, type ShellDestination } from '../shell-navigation'
import { CascadeIcon, HomeIcon, KnowledgeIcon, ReviewIcon, SettingsIcon, SourcesIcon } from './icons'

const contextCakeLogo = `${import.meta.env.BASE_URL}favicon.svg`
const BROWSER_KEY = 'contextcake.sidebar'
const COLLAPSED_WIDTH = 64
const MIN_WIDTH = 208
const DEFAULT_WIDTH = 232
const MAX_WIDTH = 300
/**
 * Quiet period before the width is persisted. The resizer updates `sidebar` on
 * every `pointermove`, and each write is an IPC round trip that the desktop
 * main process answers with a settings read-write-rename — 60–120 of them a
 * second, on the thread that draws. Nobody needs an intermediate width on disk;
 * only where the drag ends. A pointer-up flush makes sure that one lands.
 */
const PERSIST_DEBOUNCE_MS = 250

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

function SidebarInner({ onOpenSettings, onNavigate }: { onOpenSettings?: () => void; onNavigate?: () => void }) {
  const { setView, signals, conflicts, sources } = useStoreData()
  const { view } = useStoreNav()
  const [sidebar, setSidebar] = useState(readPreference)
  const [resizing, setResizing] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  const browserViews = useRef(readBrowserGroupedViews())
  const knowledgeView = useRef(window.__CC_DESKTOP?.uiState?.initial.knowledgeView ?? browserViews.current.knowledgeView)
  const reviewView = useRef(window.__CC_DESKTOP?.uiState?.initial.reviewView ?? browserViews.current.reviewView)
  if (view === 'concepts' || view === 'files') knowledgeView.current = view
  if (view === 'triage' || view === 'conflicts') reviewView.current = view

  const reviewCount = signals.filter((signal) => signal.route === 'review_required').length
    + conflicts.filter((conflict) => ['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'].includes(conflict.discrepancyStatus ?? (conflict.status === 'open' ? 'needs_review' : 'resolved'))).length
  const sourceErrors = sources.filter((source) => source.status === 'degraded' || source.status === 'error').length

  const go = (destination: ShellDestination) => {
    setView(viewForDestination(destination, knowledgeView.current, reviewView.current))
    onNavigate?.()
  }

  const persist = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: SidebarPreference | null }>({ timer: null, pending: null })

  const flushPreference = useCallback(() => {
    const state = persist.current
    if (state.timer !== null) { clearTimeout(state.timer); state.timer = null }
    const value = state.pending
    if (!value) return
    state.pending = null
    window.__CC_DESKTOP?.uiState?.set({ sidebar: value }).catch(() => {})
    if (!window.__CC_DESKTOP) {
      try { localStorage.setItem(BROWSER_KEY, JSON.stringify(value)) } catch { /* optional */ }
    }
  }, [])

  // Nothing is written for the value we just read back — the store already
  // holds it. Every later change is written once the drag (or the arrow-key
  // run) goes quiet, and immediately on unmount so a closing window still
  // records where the user left the divider.
  const hydrated = useRef(false)
  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return }
    const state = persist.current
    state.pending = sidebar
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = setTimeout(() => { state.timer = null; flushPreference() }, PERSIST_DEBOUNCE_MS)
  }, [flushPreference, sidebar])

  // The drag is over: write where it ended now rather than 250ms from now.
  // Declared after the effect above so that, in the commit where both fire,
  // the final width is already the pending value.
  useEffect(() => { if (!resizing) flushPreference() }, [flushPreference, resizing])

  useEffect(() => () => flushPreference(), [flushPreference])

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
        if (current.collapsed) return direction > 0 ? { collapsed: false, width: current.width } : current
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
            aria-label={sidebar.collapsed || badge ? `${item.label}${badge ? `, ${badge} ${suffix}` : ''}` : undefined}
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

/**
 * Memoized, and subscribed to the data and navigation halves of the store only.
 * The shell re-renders on every keystroke in the toolbar search; the sidebar has
 * nothing to say about a query, and its resizer state is local, so it should sit
 * that render out entirely.
 */
export const Sidebar = memo(SidebarInner)
