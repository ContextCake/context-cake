import { memo, useEffect, useRef } from 'react'
import { useStoreData, useStoreInput, useStoreNav, type ViewId } from '../store'
import { destinationForView, SEARCHABLE_VIEWS } from '../shell-navigation'
import { AgentIcon, PlusIcon, SidebarIcon, SparkleIcon } from './icons'
import { BackgroundActivity } from './BackgroundActivity'
import { Button, IconButton, SearchField, SegmentedControl, StatusBadge } from './ui'

const TITLES: Record<ViewId, string> = {
  overview: 'Home', canvas: 'Cascade', sources: 'Sources', triage: 'Review',
  conflicts: 'Review', concepts: 'Knowledge', files: 'Knowledge',
}

function HeaderInner({
  onToggleSidebar, onAsk, onAddSource, onConnectAgent,
}: {
  onToggleSidebar: () => void
  onAsk: () => void
  onAddSource?: () => void
  onConnectAgent?: () => void
}) {
  const { setView, setQuery, loadErrors, mode, signals, conflicts } = useStoreData()
  const { view } = useStoreNav()
  const { query } = useStoreInput()
  const search = useRef<HTMLInputElement>(null)
  const destination = destinationForView(view)
  const searchable = SEARCHABLE_VIEWS.has(view)
  const queueCount = signals.filter((signal) => signal.route === 'review_required').length
  const conflictCount = conflicts.filter((conflict) => ['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'].includes(conflict.discrepancyStatus ?? (conflict.status === 'open' ? 'needs_review' : 'resolved'))).length

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
          { value: 'triage', label: `Queue ${queueCount}` }, { value: 'conflicts', label: `Discrepancies ${conflictCount}` },
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
          label={`Search ${view === 'triage' ? 'queue' : view === 'conflicts' ? 'discrepancies' : view}`}
          placeholder={`Search ${view === 'triage' ? 'queue' : view === 'conflicts' ? 'discrepancies' : view}`}
        />}
        {/* Background work and its health, from every destination — a count
            with no progress and no detail was the badge this replaces. */}
        <BackgroundActivity />
        {loadErrors.length > 0 && <StatusBadge tone="attention">{loadErrors.length} failed</StatusBadge>}
        {view === 'sources' && mode === 'live' && onAddSource && <Button variant="primary" onClick={onAddSource}><PlusIcon />Add Source</Button>}
        {view === 'sources' && onConnectAgent && <IconButton label="Connect Agent" onClick={onConnectAgent}><AgentIcon /></IconButton>}
        <Button className="cc-toolbar-ask" variant="quiet" onClick={onAsk}><SparkleIcon />Ask</Button>
      </div>
    </header>
  )
}

/**
 * Memoized. The shell re-renders for its own reasons — a drawer, a dialog, a
 * background-activity tick — and this view has no business repainting for any
 * of them. It re-renders when the store slices it subscribes to change, and
 * otherwise not at all.
 */
export const Header = memo(HeaderInner)
