import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './store'
import { C, css, MONO } from './theme'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { Canvas } from './views/Canvas'
import { Overview } from './views/Overview'
import { Sources } from './views/Sources'
import { Triage } from './views/Triage'
import { Conflicts } from './views/Conflicts'
import { Concepts } from './views/Concepts'
import { Files } from './views/Files'
import { ChatPanel } from './components/ChatPanel'
import { SetupWizard } from './components/SetupWizard'
import { ConnectAgentDialog } from './components/ConnectAgentDialog'
import { SettingsView } from './components/SettingsView'
import type { LiveErrorKind } from './api'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { readBrowserGroupedViews, SEARCHABLE_VIEWS, viewForDestination } from './shell-navigation'

const ERROR_COPY: Record<LiveErrorKind, (msg: string) => string> = {
  unreachable: () => "Can't reach the ContextCake server. Start it with `npm run console:live`, or view the demo.",
  'bad-status': (msg) => msg,
  'bad-shape': (msg) => msg,
}

// Shown only while the source topology is unknown — a few milliseconds, since
// the engine answers /api/graph from its background index. Reading sources
// happens after the shell is up (see the indexing banner), never in front of it.
function LoadingState() {
  return (
    <div style={css(`display:grid; place-items:center; height:100vh; width:100%; background:${C.page};`)}>
      <div style={css('display:flex; flex-direction:column; align-items:center; gap:14px;')}>
        <div style={css('display:flex; gap:5px;')}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={css(`width:9px; height:9px; border-radius:999px; background:${C.tealStroke}; animation:ccPulse 1.1s ease-in-out ${i * 0.15}s infinite;`)}
            />
          ))}
        </div>
        <div style={css(`font-family:${MONO}; font-size:12.5px; color:${C.caption}; letter-spacing:0.02em;`)}>Starting ContextCake…</div>
      </div>
    </div>
  )
}

function ErrorState({ kind, message, reload }: { kind: LiveErrorKind; message: string; reload: () => void }) {
  const text = ERROR_COPY[kind](message)
  return (
    <div style={css(`display:grid; place-items:center; height:100vh; width:100%; background:${C.page}; padding:24px;`)}>
      <div style={css(`display:flex; flex-direction:column; gap:14px; max-width:440px; padding:24px; background:${C.surface}; border:1px solid ${C.amberStroke}; border-radius:14px;`)}>
        <div style={css('display:flex; align-items:center; gap:10px;')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--cc-amber-text)' }} strokeWidth="2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
          <h2 style={css(`margin:0; font-size:15px; font-weight:600; color:${C.amberText};`)}>Live data unavailable</h2>
        </div>
        <p style={css(`margin:0; font-size:13px; line-height:1.5; color:${C.body};`)}>{text}</p>
        <button
          className="cc-h-bd-strong"
          onClick={reload}
          style={css(`align-self:flex-start; padding:9px 16px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; border-radius:9px; cursor:pointer; font:inherit; font-weight:600; font-size:12.5px; color:${C.tealText};`)}
        >Retry</button>
      </div>
    </div>
  )
}

export function App() {
  const { view, setView, chatOpen, openChat, closeChat, route, loading, load, error, reload, mode, sources, loadErrors } = useStore()
  // Undefined = not yet decided by the auto-trigger effect below; true/false
  // once the user (or the trigger) has taken an explicit stance. Kept separate
  // from `needsSetup` so the wizard's own Success step stays visible even
  // after a source is added and `sources.length` flips away from zero.
  const [wizardOpen, setWizardOpen] = useState<boolean | undefined>(undefined)
  const [connectOpen, setConnectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceSetupComplete, setSourceSetupComplete] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const settingsOpener = useRef<HTMLElement | null>(null)
  const paletteOpener = useRef<HTMLElement | null>(null)
  const askOpener = useRef<HTMLElement | null>(null)
  const drawerOpener = useRef<HTMLElement | null>(null)
  const browserViews = useRef(readBrowserGroupedViews())
  const knowledgeView = useRef<'concepts' | 'files'>(window.__CC_DESKTOP?.uiState?.initial.knowledgeView ?? browserViews.current.knowledgeView)
  const reviewView = useRef<'triage' | 'conflicts'>(window.__CC_DESKTOP?.uiState?.initial.reviewView ?? browserViews.current.reviewView)
  if (view === 'concepts' || view === 'files') knowledgeView.current = view
  if (view === 'triage' || view === 'conflicts') reviewView.current = view

  const needsSetup = mode === 'live' && !loading && !error && sources.length === 0
  const isDesktop = typeof window !== 'undefined' && Boolean(window.__CC_DESKTOP)

  useEffect(() => {
    if (needsSetup && wizardOpen === undefined) setWizardOpen(true)
  }, [needsSetup, wizardOpen])

  const showWizard = wizardOpen === true
  const closeWizard = () => setWizardOpen(false)
  const reopenWizard = () => setWizardOpen(true)
  const openConnect = () => {
    if (sources.length === 0 && !sourceSetupComplete) {
      setWizardOpen(true)
      return
    }
    setConnectOpen(true)
  }
  const openSettings = () => {
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerOpen(false)
    setSettingsOpen(true)
  }
  const openPalette = () => {
    paletteOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerOpen(false)
    setPaletteOpen(true)
  }
  const closePalette = () => {
    const opener = paletteOpener.current
    setPaletteOpen(false)
    window.requestAnimationFrame(() => opener?.isConnected && opener.focus())
  }
  const openAsk = useCallback(() => {
    askOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerOpen(false)
    openChat()
  }, [openChat])
  const closeAsk = useCallback(() => {
    const opener = askOpener.current
    closeChat()
    window.requestAnimationFrame(() => opener?.isConnected && opener.focus())
  }, [closeChat])
  const closeDrawer = useCallback(() => {
    const opener = drawerOpener.current
    setDrawerOpen(false)
    window.requestAnimationFrame(() => opener?.isConnected && opener.focus())
  }, [])
  const toggleSidebar = () => {
    if (window.innerWidth < 900) {
      if (drawerOpen) closeDrawer()
      else {
        drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setDrawerOpen(true)
      }
    }
    else window.dispatchEvent(new Event('contextcake:toggle-sidebar'))
  }

  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    { id: 'home', label: 'Go to Home', keywords: 'overview', shortcut: '⌘1', run: () => setView('overview') },
    { id: 'cascade', label: 'Go to Cascade', keywords: 'canvas graph', shortcut: '⌘2', run: () => setView('canvas') },
    { id: 'concepts', label: 'Go to Knowledge: Concepts', keywords: 'browse', run: () => setView('concepts') },
    { id: 'files', label: 'Go to Knowledge: Files', keywords: 'markdown documents', run: () => setView('files') },
    { id: 'sources', label: 'Go to Sources', shortcut: '⌘4', run: () => setView('sources') },
    { id: 'queue', label: 'Go to Review: Queue', keywords: 'triage', run: () => setView('triage') },
    { id: 'conflicts', label: 'Go to Review: Conflicts', keywords: 'resolve', run: () => setView('conflicts') },
    ...(mode === 'live' ? [{ id: 'add-source', label: 'Add Source', keywords: 'folder repository', run: reopenWizard }] : []),
    ...(isDesktop ? [{ id: 'connect-agent', label: 'Connect Agent', keywords: 'cli mcp', run: openConnect }] : []),
    { id: 'ask', label: 'Ask ContextCake', shortcut: '⇧⌘A', run: openAsk },
    { id: 'settings', label: 'Open Settings', shortcut: '⌘,', run: openSettings },
    { id: 'sidebar', label: 'Toggle Sidebar', run: toggleSidebar },
  ], [isDesktop, mode, setView, sources.length, sourceSetupComplete])
  const closeSettings = () => {
    const opener = settingsOpener.current
    setSettingsOpen(false)
    window.requestAnimationFrame(() => {
      const candidates = [
        opener,
        document.querySelector<HTMLElement>('.cc-settings-cta'),
        document.querySelector<HTMLElement>('.cc-toolbar-leading button'),
      ]
      candidates.find((candidate) => {
        if (!candidate?.isConnected) return false
        if (!candidate.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) return false
        const rect = candidate.getBoundingClientRect()
        const hasNoLayout = rect.width === 0 && rect.height === 0
        const visible = hasNoLayout || (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight)
        if (visible) candidate.focus()
        return visible
      })
      settingsOpener.current = null
    })
  }

  // Mobile off-canvas nav drawer (inert on desktop, where the sidebar is static).
  useEffect(() => {
    if (!drawerOpen || settingsOpen) return
    const sidebar = document.querySelector<HTMLElement>('.cc-sidebar')
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('button,a[href],[tabindex]:not([tabindex="-1"])') ?? [])
    sidebar?.querySelector<HTMLElement>('.cc-nav-button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const position = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (position - 1 + items.length) % items.length : (position + 1) % items.length
      e.preventDefault(); items[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDrawer, drawerOpen, settingsOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = e.metaKey || e.ctrlKey
      const target = e.target
      const editing = target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')
      if (command && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!showWizard && !connectOpen && !settingsOpen) openPalette()
      } else if (command && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (!showWizard && !connectOpen && !settingsOpen) openAsk()
      } else if (command && e.key.toLowerCase() === 'f' && SEARCHABLE_VIEWS.has(view)) {
        e.preventDefault()
        window.dispatchEvent(new Event('contextcake:focus-search'))
      } else if (command && !editing && !e.shiftKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault()
        const destinations = ['home', 'cascade', 'knowledge', 'sources', 'review'] as const
        setView(viewForDestination(destinations[Number(e.key) - 1], knowledgeView.current, reviewView.current))
      } else if (command && e.key === ',') {
        e.preventDefault()
        if (!showWizard && !connectOpen) openSettings()
      } else if (e.key === 'Escape' && paletteOpen) {
        e.preventDefault(); closePalette()
      } else if (e.key === 'Escape' && settingsOpen) {
        e.preventDefault()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connectOpen, paletteOpen, settingsOpen, showWizard, view, setView])

  useEffect(() => window.__CC_DESKTOP?.commands?.onInvoke((command) => {
    const active = document.activeElement
    const editing = active instanceof Element && active.matches('input, textarea, select, [contenteditable="true"]')
    const modalOpen = showWizard || connectOpen || settingsOpen
    if (command === 'command-palette' && !modalOpen) openPalette()
    else if (command === 'search' && SEARCHABLE_VIEWS.has(view) && !modalOpen) window.dispatchEvent(new Event('contextcake:focus-search'))
    else if (command === 'ask' && !modalOpen) openAsk()
    else if (command === 'settings' && !showWizard && !connectOpen) openSettings()
    else if (command === 'toggle-sidebar') toggleSidebar()
    else if (command.startsWith('destination:') && !editing && !modalOpen && !paletteOpen) {
      const number = Number(command.slice(-1))
      const destinations = ['home', 'cascade', 'knowledge', 'sources', 'review'] as const
      if (number >= 1 && number <= 5) setView(viewForDestination(destinations[number - 1], knowledgeView.current, reviewView.current))
    }
  }), [connectOpen, paletteOpen, setView, settingsOpen, showWizard, view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen || view !== 'triage' || chatOpen) return
      // Leave browser/OS chords (⌘S, Ctrl+D, Alt+…) alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = ((e.target as HTMLElement)?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const k = e.key.toLowerCase()
      if (k === 's') route('team_candidate')
      else if (k === 'r') route('review_required')
      else if (k === 'd') route('ignore')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, view, chatOpen, route])

  // The wizard's own reload() (step 6, Success) briefly flips `loading` true.
  // SetupWizard is rendered once, at a single stable position in the tree
  // (outside the loading/error/shell swap below), so its local step state
  // survives that reload instead of being unmounted and reset to step 1.
  let body: React.ReactNode
  if (loading) {
    body = <LoadingState />
  } else if (error) {
    body = <ErrorState kind={error.kind} message={error.message} reload={reload} />
  } else {
    body = (
      <div className="cc-app-shell" data-drawer={drawerOpen ? 'open' : 'closed'} data-ask={chatOpen ? 'open' : 'closed'}>
        <div className="cc-drawer-scrim" onClick={closeDrawer} aria-hidden="true" />
        <div className="cc-shell-inner">
          <Sidebar onOpenSettings={openSettings} onNavigate={closeDrawer} />
          <div className="cc-content" aria-hidden={drawerOpen || undefined} inert={drawerOpen || undefined}>
            <Header
              onToggleSidebar={toggleSidebar} onAsk={openAsk}
              onAddSource={mode === 'live' ? reopenWizard : undefined}
              onConnectAgent={isDesktop && !needsSetup ? openConnect : undefined}
            />
            <div className="sr-only" aria-live="polite">
              {load.indexingSources.length > 0 ? `Indexing ${load.indexingSources.length} sources.` : 'Indexing complete.'}
              {loadErrors.length > 0 ? ` ${loadErrors.length} concepts failed to resolve.` : ''}
            </div>
            {loadErrors.length > 0 && (
              <div role="status" style={css(`display:flex; align-items:center; gap:8px; padding:8px 16px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; font-size:12px; color:${C.amberText};`)}>
                <span aria-hidden="true">⚠</span>
                <span>
                  {loadErrors.length} concept{loadErrors.length === 1 ? '' : 's'} failed to resolve
                  {' '}({loadErrors.map((e) => e.concept).slice(0, 3).join(', ')}{loadErrors.length > 3 ? ', …' : ''}) — showing the rest.
                </span>
              </div>
            )}
            {view === 'canvas' ? (
              <main className="cc-main cc-main-canvas">
                <Canvas keyboardSuspended={settingsOpen || paletteOpen || chatOpen || drawerOpen} />
              </main>
            ) : (
              <main className="cc-main">
                {view === 'overview' && <Overview />}
                {view === 'sources' && <Sources onAddSource={mode === 'live' ? reopenWizard : undefined} />}
                {view === 'triage' && <Triage />}
                {view === 'conflicts' && <Conflicts />}
                {view === 'concepts' && <Concepts />}
                {view === 'files' && <Files />}
              </main>
            )}
          </div>
        </div>
        {chatOpen && <ChatPanel keyboardSuspended={settingsOpen || paletteOpen} onConnectAgent={isDesktop ? openConnect : undefined} onClose={closeAsk} />}
      </div>
    )
  }

  return (
    <>
      <div className="cc-app-layer" aria-hidden={(settingsOpen || paletteOpen) || undefined} inert={(settingsOpen || paletteOpen) || undefined}>{body}</div>
      {settingsOpen && <SettingsView appMode={mode} onClose={closeSettings} onIndexingChange={reload} />}
      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={closePalette} />}
      {showWizard && <SetupWizard addingSource={sources.length > 0} onClose={closeWizard} onConnectAgent={isDesktop ? () => {
        setSourceSetupComplete(true)
        setWizardOpen(false)
        setConnectOpen(true)
      } : undefined} />}
      {connectOpen && (
        <ConnectAgentDialog
          hasSources={sources.length > 0 || sourceSetupComplete}
          onClose={() => setConnectOpen(false)}
          onOpenSetup={reopenWizard}
        />
      )}
    </>
  )
}
