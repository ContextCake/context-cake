import { useEffect, useRef } from 'react'
import { useStore, type ViewId } from '../store'
import { destinationForView, SEARCHABLE_VIEWS } from '../shell-navigation'
import { AgentIcon, PlusIcon, SidebarIcon, SparkleIcon } from './icons'
import { Button, IconButton, SearchField, SegmentedControl, StatusBadge } from './ui'

const TITLES: Record<ViewId, string> = {
  overview: 'Home', canvas: 'Cascade', sources: 'Sources', triage: 'Review',
  conflicts: 'Review', concepts: 'Knowledge', files: 'Knowledge',
}

export function Header({
  onToggleSidebar, onAsk, onAddSource, onConnectAgent,
}: {
  onToggleSidebar: () => void
  onAsk: () => void
  onAddSource?: () => void
  onConnectAgent?: () => void
}) {
  const { view, setView, query, setQuery, load, loadErrors, mode, signals, conflicts } = useStore()
  const search = useRef<HTMLInputElement>(null)
  const destination = destinationForView(view)
  const searchable = SEARCHABLE_VIEWS.has(view)
  const queueCount = signals.filter((signal) => signal.route === 'review_required').length
  const conflictCount = conflicts.filter((conflict) => conflict.status === 'open').length

  useEffect(() => {
    const focus = () => search.current?.focus()
    window.addEventListener('contextcake:focus-search', focus)
    return () => window.removeEventListener('contextcake:focus-search', focus)
  }, [])

  return (
    <header className="cc-toolbar">
      <div className="cc-toolbar-leading">
        <IconButton label="Toggle sidebar" onClick={onToggleSidebar}><SidebarIcon /></IconButton>
        <h1>{TITLES[view]}</h1>
      </div>
      <div className="cc-toolbar-center">
        {destination === 'knowledge' && <SegmentedControl label="Knowledge view" value={view as 'concepts' | 'files'} onChange={setView} options={[
          { value: 'concepts', label: 'Concepts' }, { value: 'files', label: 'Files' },
        ]} />}
        {destination === 'review' && <SegmentedControl label="Review view" value={view as 'triage' | 'conflicts'} onChange={setView} options={[
          { value: 'triage', label: `Queue ${queueCount}` }, { value: 'conflicts', label: `Conflicts ${conflictCount}` },
        ]} />}
      </div>
      <div className="cc-toolbar-actions">
        {searchable && <SearchField
          ref={search} data-context-search value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              event.stopPropagation()
              setQuery('')
            }
          }}
          label={`Search ${view === 'triage' ? 'queue' : view}`}
          placeholder={`Search ${view === 'triage' ? 'queue' : view}`}
        />}
        {load.indexingSources.length > 0 && <StatusBadge tone="info">Indexing {load.indexingSources.length}</StatusBadge>}
        {loadErrors.length > 0 && <StatusBadge tone="attention">{loadErrors.length} failed</StatusBadge>}
        {view === 'sources' && mode === 'live' && onAddSource && <Button variant="primary" onClick={onAddSource}><PlusIcon />Add Source</Button>}
        {view === 'sources' && onConnectAgent && <IconButton label="Connect Agent" onClick={onConnectAgent}><AgentIcon /></IconButton>}
        <Button className="cc-toolbar-ask" variant="quiet" onClick={onAsk}><SparkleIcon />Ask</Button>
      </div>
    </header>
  )
}
