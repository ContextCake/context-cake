import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { Canvas } from './views/Canvas'
import { Overview } from './views/Overview'
import { Triage } from './views/Triage'
import { Conflicts } from './views/Conflicts'
import { Concepts } from './views/Concepts'
import { ChatPanel } from './components/ChatPanel'

export function App() {
  const { view, chatOpen, route } = useStore()

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

  return (
    <div className="cc-app-shell">
      <div className="cc-shell-inner">
        <Sidebar />
        <Header />
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
      {chatOpen && <ChatPanel />}
    </div>
  )
}
