import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStoreData, useStoreNav } from './store'
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
import { EngineBanner } from './components/EngineBanner'
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
  // Deliberately three narrow subscriptions rather than `useStore()`: the shell
  // owns every memoized child below, so an App render is a whole-tree render.
  // Typing in the toolbar search must not cause one.
  const { setView, openChat, closeChat, route, loading, load, error, reload, retryNow, mode, sources, loadErrors, openFilesScope } = useStoreData()
  const { view, chatOpen } = useStoreNav()
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
  const [backgroundAnnouncement, setBackgroundAnnouncement] = useState('')
  const settingsOpener = useRef<HTMLElement | null>(null)
  const paletteOpener = useRef<HTMLElement | null>(null)
  const askOpener = useRef<HTMLElement | null>(null)
  const drawerOpener = useRef<HTMLElement | null>(null)
  const browserViews = useRef(readBrowserGroupedViews())
  const knowledgeView = useRef<'concepts' | 'files'>(window.__CC_DESKTOP?.uiState?.initial.knowledgeView ?? browserViews.current.knowledgeView)
  const reviewView = useRef<'triage' | 'conflicts'>(window.__CC_DESKTOP?.uiState?.initial.reviewView ?? browserViews.current.reviewView)
  const backgroundCounts = useRef({ indexing: 0, failures: 0, names: '' })
  const refreshNotice = useRef<string | null>(null)
  // Dismissal is per-failure, not forever: a new failure message re-surfaces
  // the banner, and so does the same one after a recovery.
  const [dismissedRefreshError, setDismissedRefreshError] = useState<string | null>(null)
  if (view === 'concepts' || view === 'files') knowledgeView.current = view
  if (view === 'triage' || view === 'conflicts') reviewView.current = view

  const needsSetup = mode === 'live' && !loading && !error && sources.length === 0
  const isDesktop = typeof window !== 'undefined' && Boolean(window.__CC_DESKTOP)

  useEffect(() => {
    if (needsSetup && wizardOpen === undefined) setWizardOpen(true)
  }, [needsSetup, wizardOpen])

  const showWizard = wizardOpen === true
  const closeWizard = () => setWizardOpen(false)
  // Handlers that reach a memoized child (Sidebar, Header, Sources, ChatPanel)
  // are stable identities. A fresh arrow function per render would re-render
  // the child through its memo and give the whole split back.
  const reopenWizard = useCallback(() => setWizardOpen(true), [])
  const openConnect = useCallback(() => {
    if (sources.length === 0 && !sourceSetupComplete) {
      setWizardOpen(true)
      return
    }
    setConnectOpen(true)
  }, [sources.length, sourceSetupComplete])
  const openSettings = useCallback(() => {
    if (window.__CC_DESKTOP?.windows) {
      setDrawerOpen(false)
      // Omit a pane so the native window can restore the user's last one.
      // Explicit pane requests remain available for flows such as OAuth.
      window.__CC_DESKTOP.windows.openSettings().catch(() => {})
      return
    }
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawerOpen(false)
    setSettingsOpen(true)
  }, [])
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
  const openAskFromPalette = useCallback(() => {
    askOpener.current = paletteOpener.current?.isConnected ? paletteOpener.current : null
    setDrawerOpen(false)
    openChat()
  }, [openChat])
  const closeAsk = useCallback(() => {
    const opener = askOpener.current
    closeChat()
    window.requestAnimationFrame(() => {
      const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('.cc-toolbar-ask')
      target?.focus()
      askOpener.current = null
    })
  }, [closeChat])
  const closeDrawer = useCallback(() => {
    const opener = drawerOpener.current
    setDrawerOpen(false)
    window.requestAnimationFrame(() => opener?.isConnected && opener.focus())
  }, [])
  const toggleSidebar = useCallback(() => {
    if (window.innerWidth < 900) {
      if (drawerOpen) closeDrawer()
      else {
        drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setDrawerOpen(true)
      }
    }
    else window.dispatchEvent(new Event('contextcake:toggle-sidebar'))
  }, [closeDrawer, drawerOpen])

  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    { id: 'home', label: 'Go to Home', keywords: 'overview', shortcut: '⌘1', run: () => setView('overview') },
    { id: 'cascade', label: 'Go to Cascade', keywords: 'canvas graph', shortcut: '⌘2', run: () => setView('canvas') },
    { id: 'concepts', label: 'Go to Knowledge: Concepts', keywords: 'browse', run: () => setView('concepts') },
    { id: 'files', label: 'Go to Knowledge: Files', keywords: 'markdown documents', shortcut: '⇧⌘F', run: () => setView('files') },
    { id: 'sources', label: 'Go to Sources', shortcut: '⌘4', run: () => setView('sources') },
    { id: 'queue', label: 'Go to Review: Queue', keywords: 'triage', run: () => setView('triage') },
    { id: 'conflicts', label: 'Go to Review: Discrepancies', keywords: 'resolve align', run: () => setView('conflicts') },
    // One per source: the palette is the keyboard route into the navigator,
    // matching the Sources panel's "Browse files" button — including in the
    // demo, where that button is offered too. Browsing is a read.
    ...sources.filter((source) => !source.quarantined).map((source) => ({
      id: `files:${source.name}`,
      label: `Browse files in ${source.name}`,
      keywords: 'navigator folder tree source files',
      run: () => openFilesScope(source.name),
    })),
    ...(mode === 'live' ? [{ id: 'add-source', label: 'Add Source', keywords: 'folder repository', run: reopenWizard }] : []),
    ...(isDesktop ? [{ id: 'connect-agent', label: 'Connect Agent', keywords: 'cli mcp', run: openConnect }] : []),
    { id: 'ask', label: 'Ask ContextCake', shortcut: '⇧⌘A', run: openAskFromPalette },
    { id: 'settings', label: 'Open Settings', shortcut: '⌘,', run: openSettings },
    { id: 'sidebar', label: 'Toggle Sidebar', run: toggleSidebar },
  ], [isDesktop, mode, openAskFromPalette, openConnect, openFilesScope, openSettings, reopenWizard, setView, sources, toggleSidebar])
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

  // Announce transitions, not ticks. A live region that re-read a progress
  // counter every 900ms would make the app unusable with a screen reader; the
  // per-task progressbar in the activity popover is where the numbers live.
  useEffect(() => {
    const indexing = load.indexingSources.length
    const failures = loadErrors.length
    const previous = backgroundCounts.current
    const names = load.indexingSources.join(', ')
    if (indexing > 0 && names !== previous.names) {
      setBackgroundAnnouncement(`Indexing ${indexing} source${indexing === 1 ? '' : 's'}: ${names}.`)
    } else if (indexing === 0 && previous.indexing > 0) {
      setBackgroundAnnouncement(`Indexing complete.${failures > 0 ? ` ${failures} concept${failures === 1 ? '' : 's'} failed to resolve.` : ''}`)
    } else if (failures > previous.failures) {
      setBackgroundAnnouncement(`${failures} concept${failures === 1 ? '' : 's'} failed to resolve.`)
    }
    backgroundCounts.current = { indexing, failures, names }
  }, [load.indexingSources, loadErrors.length])

  // A failing background refresh is announced once per distinct failure, and
  // once again when it recovers. Silence here is what made the old give-up
  // indistinguishable from a working page.
  useEffect(() => {
    const message = load.refreshError?.message ?? null
    if (message === refreshNotice.current) return
    refreshNotice.current = message
    setBackgroundAnnouncement(message
      ? 'Live refresh is failing. Retrying — the page is showing the last good data.'
      : 'Live refresh recovered.')
  }, [load.refreshError])

  // Recovery ends the dismissal. Holding it past a recovery made it a
  // session-long mute rather than a per-message one: the next outage, if it
  // read the same way ("socket hang up" usually does), never reached the user
  // again — a page silently frozen behind a banner it had been told to hide.
  useEffect(() => {
    if (!load.refreshError) setDismissedRefreshError(null)
  }, [load.refreshError])


  // Mobile off-canvas nav drawer (inert on desktop, where the sidebar is static).
  useEffect(() => {
    if (!drawerOpen || settingsOpen) return
    const sidebar = document.querySelector<HTMLElement>('.cc-sidebar')
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('button,a[href],[tabindex]:not([tabindex="-1"])') ?? [])
    sidebar?.querySelector<HTMLElement>('.cc-nav-button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
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
      // Contextual controls get first refusal. In particular, Escape must
      // clear a populated search field without also dismissing its detail
      // sheet as the event bubbles to this shell-level handler.
      if (e.defaultPrevented) return
      const command = e.metaKey || e.ctrlKey
      const target = e.target
      const editing = target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')
      if (command && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!showWizard && !connectOpen && !settingsOpen) openPalette()
      } else if (command && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (!showWizard && !connectOpen && !settingsOpen) openAsk()
      } else if (command && e.shiftKey && e.key.toLowerCase() === 'f') {
        // ⇧⌘F is the navigator, ⌘F is search-this-view — the desktop View menu
        // carries the same pair, so the two surfaces agree.
        e.preventDefault()
        if (!showWizard && !connectOpen && !settingsOpen) setView('files')
      } else if (command && !e.shiftKey && e.key.toLowerCase() === 'f' && SEARCHABLE_VIEWS.has(view)) {
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
      } else if (e.key === 'Escape' && !showWizard && !connectOpen && !chatOpen) {
        window.dispatchEvent(new Event('contextcake:close-detail'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatOpen, connectOpen, paletteOpen, settingsOpen, showWizard, view, setView])

  useEffect(() => window.__CC_DESKTOP?.commands?.onInvoke((command) => {
    const active = document.activeElement
    const editing = active instanceof Element && active.matches('input, textarea, select, [contenteditable="true"]')
    const modalOpen = showWizard || connectOpen || settingsOpen
    if (command === 'command-palette' && !modalOpen) openPalette()
    else if (command === 'view:files' && !modalOpen) setView('files')
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

  useEffect(() => window.__CC_DESKTOP?.data?.onReloadRequested(() => reload()), [reload])

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
            {mode === 'demo' && (
              <div className="cc-global-simulation" role="status">
                <strong>Simulation—no files will change.</strong>
                <span>Actions and history reset on reload. Automatic rules never run.</span>
              </div>
            )}
            <div className="sr-only" aria-live="polite">
              {backgroundAnnouncement}
            </div>
            {/*
              Above the refresh banner on purpose: a wedged engine is the CAUSE
              of the failing refresh below it, and holds its own state so this
              app-wide render never runs for it.
            */}
            <EngineBanner />
            {load.refreshError && load.refreshError.message !== dismissedRefreshError && (
              <div role="status" style={css(`display:flex; align-items:center; gap:10px; padding:8px 16px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; font-size:12px; color:${C.amberText};`)}>
                <span aria-hidden="true">⚠</span>
                <span style={css('flex:1 1 auto; min-width:0; overflow-wrap:anywhere;')}>
                  Live refresh failing — retrying. Showing the last good data
                  {load.lastRefreshAt ? ` from ${new Date(load.lastRefreshAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
                  {' '}{load.refreshError.message}
                </span>
                <button type="button" className="cc-activity-action" onClick={retryNow}>Retry now</button>
                <button
                  type="button"
                  className="cc-activity-action"
                  aria-label="Dismiss the live refresh warning"
                  onClick={() => setDismissedRefreshError(load.refreshError?.message ?? null)}
                >Dismiss</button>
              </div>
            )}
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
