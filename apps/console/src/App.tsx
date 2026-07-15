import { useEffect, useState } from 'react'
import { useStore } from './store'
import { C, css, MONO } from './theme'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { Canvas } from './views/Canvas'
import { Overview } from './views/Overview'
import { Triage } from './views/Triage'
import { Conflicts } from './views/Conflicts'
import { Concepts } from './views/Concepts'
import { ChatPanel } from './components/ChatPanel'
import { SetupWizard } from './components/SetupWizard'
import { ConnectAgentDialog } from './components/ConnectAgentDialog'
import type { LiveErrorKind } from './api'

const ERROR_COPY: Record<LiveErrorKind, (msg: string) => string> = {
  unreachable: () => "Can't reach the ContextCake server. Start it with `npm run console:live`, or view the demo.",
  'bad-status': (msg) => msg,
  'bad-shape': (msg) => msg,
}

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
        <div style={css(`font-family:${MONO}; font-size:12.5px; color:${C.caption}; letter-spacing:0.02em;`)}>Resolving the cascade…</div>
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
  const { view, chatOpen, route, loading, error, reload, mode, sources, loadErrors } = useStore()
  // Undefined = not yet decided by the auto-trigger effect below; true/false
  // once the user (or the trigger) has taken an explicit stance. Kept separate
  // from `needsSetup` so the wizard's own Success step stays visible even
  // after a source is added and `sources.length` flips away from zero.
  const [wizardOpen, setWizardOpen] = useState<boolean | undefined>(undefined)
  const [connectOpen, setConnectOpen] = useState(false)
  const [sourceSetupComplete, setSourceSetupComplete] = useState(false)

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

  // Mobile off-canvas nav drawer (inert on desktop, where the sidebar is static).
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = () => setDrawerOpen(false)
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== 'triage' || chatOpen) return
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
  }, [view, chatOpen, route])

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
      <div className="cc-app-shell" data-drawer={drawerOpen ? 'open' : 'closed'}>
        <div className="cc-drawer-scrim" onClick={closeDrawer} aria-hidden="true" />
        <div className="cc-shell-inner">
          <Sidebar
            onReopenSetup={needsSetup ? reopenWizard : undefined}
            onConnectAgent={isDesktop && !needsSetup ? openConnect : undefined}
            onNavigate={closeDrawer}
          />
          <div className="cc-content">
            <Header onOpenMenu={() => setDrawerOpen(true)} />
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
                <Canvas />
              </main>
            ) : (
              <main className="cc-main">
                {view === 'overview' && <Overview />}
                {view === 'triage' && <Triage />}
                {view === 'conflicts' && <Conflicts />}
                {view === 'concepts' && <Concepts />}
              </main>
            )}
          </div>
        </div>
        {chatOpen && <ChatPanel onConnectAgent={isDesktop ? openConnect : undefined} />}
      </div>
    )
  }

  return (
    <>
      {body}
      {showWizard && <SetupWizard onClose={closeWizard} onConnectAgent={isDesktop ? () => {
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
