import { useEffect } from 'react'
import { css } from './theme'
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
    <div style={css("display:flex; min-height:100vh; background:#F1F0EA; color:#1A1915; font-size:14px; line-height:1.5;")}>
      <Sidebar />
      <div style={css('flex:1; min-width:0; display:flex; flex-direction:column;')}>
        <Header />
        {view === 'canvas' ? (
          <main style={css('height:calc(100vh - 66px);')}>
            <Canvas />
          </main>
        ) : (
          <main style={css('padding:24px 26px 60px;')}>
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
