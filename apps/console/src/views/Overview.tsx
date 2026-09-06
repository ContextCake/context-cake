import { memo, useMemo, useState } from 'react'
import { progressLabel } from '../api'
import { computeCascadeOrder, rankLabel } from '../cascade-order'
import type { Concept, Source } from '../data'
import { useStoreData } from '../store'
import { actionableByKind, summarizeConflicts } from '../discrepancy-summary'
import './workspace.css'

function latestSectionDate(concept: Concept): string | null {
  // Compact graph rows do not know every section yet. Never turn missing
  // dates into a made-up "recently viewed" feed or issue N detail requests.
  if (concept.detailLoaded === false) return null
  const dates = concept.sections.map((section) => section.updated).filter((date): date is string => Boolean(date) && Number.isFinite(Date.parse(date!)))
  return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
}

function sourceState(source: Source): string {
  if (source.quarantined) return 'Invalid configuration'
  if (source.status === 'error') return 'Unavailable'
  if (source.status === 'degraded') return 'Partial context'
  if (source.status === 'indexing') return progressLabel(source.indexing)
  if (source.indexing?.refreshing) return 'Refreshing'
  if (source.warnings) return `${source.warnings} indexing warning${source.warnings === 1 ? '' : 's'}`
  if (source.status === 'empty' || source.conceptCount === 0) return 'No indexed documents'
  return 'Available'
}

function discrepancyKinds(kinds: Record<string, number>): string {
  return [['broken_link', 'broken link'], ['section_content', 'section'], ['frontmatter_value', 'value'], ['changed_after_decision', 'changed decision']]
    .filter(([key]) => kinds[key] > 0)
    .map(([key, noun]) => `${kinds[key]} ${noun}${kinds[key] === 1 ? '' : 's'}`).join(' · ')
}

function OverviewInner({ onConnectAgent }: { onConnectAgent?: () => void }) {
  const [question, setQuestion] = useState('')
  const { mode, setView, openConcept, openConceptSearch, signals, conflicts, conflictSummary, sources, concepts, loadErrors, load } = useStoreData()
  const summary = conflictSummary ?? summarizeConflicts(conflicts)
  const queueCount = signals.filter((signal) => signal.route === 'review_required').length
  const unhealthy = sources.filter((source) => source.quarantined || source.status === 'error' || source.status === 'degraded' || Boolean(source.warnings))
  const indexing = sources.some((source) => source.status === 'indexing' || source.indexing?.refreshing)
  const partial = unhealthy.length > 0 || indexing || loadErrors.length > 0 || Boolean(load?.refreshError)
  const cascade = computeCascadeOrder(sources.filter((source) => !source.quarantined))
  const positions = new Map(cascade.map((source) => [source.name, rankLabel(source)]))
  const orderedSources = [...cascade, ...sources.filter((source) => source.quarantined)]
  const dated = useMemo(() => concepts.flatMap((concept) => {
    const date = latestSectionDate(concept)
    return date ? [{ concept, date }] : []
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.concept.title.localeCompare(b.concept.title)).slice(0, 6), [concepts])
  const datedIds = new Set(dated.map(({ concept }) => concept.id))
  const documents = [...dated, ...concepts.filter((concept) => !datedIds.has(concept.id)).slice(0, 6 - dated.length).map((concept) => ({ concept, date: null }))]
  const reviewHeading = summary.actionable
    ? `${summary.actionable} discrepanc${summary.actionable === 1 ? 'y needs' : 'ies need'} review`
    : partial ? 'Your context is incomplete' : load?.concepts ? 'Checking your context' : sources.length ? 'No open discrepancies' : 'Start with a source'
  const reviewBody = summary.actionable
    ? 'Compare the sources, choose a resolution, or set a source policy.'
    : partial ? 'You can work with available documents. Check source status before relying on coverage.'
      : load?.concepts ? 'Documents are available while the rest of your context loads.'
        : sources.length ? 'Recorded decisions and source evidence are available in Trust.'
          : 'Connect a project folder, repository, or knowledge source to build your workspace.'

  return (
    <div className="cc-workspace">
      <section className="cc-workspace-find" aria-labelledby="cc-workspace-find-title">
        <div className="cc-workspace-intro"><h2 id="cc-workspace-find-title">Context for your next change.</h2><p>Find the decisions, instructions, and notes your work depends on.</p></div>
        <form className="cc-workspace-search" role="search" onSubmit={(event) => { event.preventDefault(); openConceptSearch(question) }}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
          <input aria-label="Search your project context" placeholder="Search your project context…" value={question} onChange={(event) => setQuestion(event.target.value)} />
          <button type="submit">Search context <span aria-hidden="true">↵</span></button>
        </form>
        <div className="cc-workspace-shortcuts"><span>Try</span>{['build and test', 'architecture', 'release process'].map((query) => <button type="button" key={query} onClick={() => openConceptSearch(query)}>{query}<span aria-hidden="true">↗</span></button>)}</div>
      </section>

      <div className="cc-workspace-columns">
        <section className="cc-workspace-documents" aria-labelledby="cc-workspace-documents-title">
          <header className="cc-workspace-heading"><div><h3 id="cc-workspace-documents-title">From your library</h3><p>Available documents, with known section dates.</p></div><button className="cc-workspace-link" type="button" onClick={() => setView('concepts')}>Browse all <span aria-hidden="true">→</span></button></header>
          {documents.length ? <ul className="cc-workspace-document-list">{documents.map(({ concept, date }) => <li key={concept.id}>
            <button type="button" onClick={() => openConcept(concept.id)}>
              <svg className="cc-workspace-document-icon" aria-hidden="true" width="20" height="24" viewBox="0 0 20 24" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M4 2h8l5 5v15H4zM12 2v6h5M7 12h7M7 16h5" /></svg>
              <span className="cc-workspace-document-copy"><strong>{concept.title}</strong><span className="cc-workspace-document-path">{concept.id}</span><span className="cc-workspace-document-sources">{(concept.contributorLayers ?? concept.layers).join(' · ')}</span></span>
              <span className="cc-workspace-document-meta">{date && <time dateTime={date}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(date))}</time>}<span>{concept.type}</span>{concept.conflict && <span className="cc-workspace-disputed">Sources differ</span>}</span>
            </button>
          </li>)}</ul> : <div className="cc-workspace-empty"><strong>{indexing ? 'Your documents are being indexed' : sources.length ? 'No indexed documents yet' : 'Bring your project into context'}</strong><p>{indexing ? 'Results appear as each source becomes available.' : 'Add a folder with project instructions, decisions, or documentation.'}</p><button className="cc-workspace-link" type="button" onClick={() => setView('sources')}>{sources.length ? 'Check sources' : 'Open Sources'} <span aria-hidden="true">→</span></button></div>}
          {partial && <p className="cc-workspace-coverage-note">Available context is shown. Indexing or source issues may limit coverage.</p>}
        </section>

        <aside className="cc-workspace-rail" aria-label="Workspace status">
          <section className="cc-workspace-review" data-attention={summary.actionable > 0 || partial || undefined} aria-labelledby="cc-workspace-review-title">
            <span className="cc-workspace-status-label"><span aria-hidden="true" />{mode === 'demo' ? 'Demo context' : 'Context status'}</span>
            <h3 id="cc-workspace-review-title">{reviewHeading}</h3><p>{reviewBody}</p>
            {summary.actionable > 0 && <><span className="cc-workspace-review-kinds">{discrepancyKinds(actionableByKind(conflicts))}</span><button className="cc-workspace-link" type="button" onClick={() => setView('conflicts')}>Review discrepancies <span aria-hidden="true">→</span></button></>}
            {!summary.actionable && !partial && !load?.concepts && sources.length > 0 && <button className="cc-workspace-link" type="button" onClick={() => setView('conflicts')}>Open Trust <span aria-hidden="true">→</span></button>}
            {!summary.actionable && (partial || !sources.length) && <button className="cc-workspace-link" type="button" onClick={() => setView('sources')}>{sources.length ? 'Check source status' : 'Open Sources'} <span aria-hidden="true">→</span></button>}
            {queueCount > 0 && <button className="cc-workspace-queue" type="button" onClick={() => setView('triage')}>{queueCount} captured item{queueCount === 1 ? '' : 's'} waiting in Queue <span aria-hidden="true">→</span></button>}
            {loadErrors.length > 0 && <p className="cc-workspace-error">{loadErrors.length} document{loadErrors.length === 1 ? '' : 's'} could not be resolved.</p>}
            {load?.refreshError && <p className="cc-workspace-error">Updates are unavailable. Showing the last loaded context.</p>}
          </section>

          <section className="cc-workspace-sources" aria-labelledby="cc-workspace-sources-title"><header className="cc-workspace-heading"><h3 id="cc-workspace-sources-title">Connected sources</h3><button className="cc-workspace-link" type="button" onClick={() => setView('sources')}>Manage</button></header>
            {orderedSources.length ? <ul>{orderedSources.map((source) => <li key={source.name}><button type="button" onClick={() => setView('sources')}>
              <span className="cc-workspace-source-order" title={source.quarantined ? 'Excluded from the cascade' : 'Cascade position'}>{positions.get(source.name) ?? '—'}</span><span className="cc-workspace-source-copy"><strong>{source.name}</strong><span>{sourceState(source)}</span>{source.error && <small>{source.error}</small>}</span><span className="cc-workspace-source-count" title="Indexed concepts">{source.conceptCount.toLocaleString()}</span>
            </button></li>)}</ul> : <p>No sources connected.</p>}
            {cascade.length > 1 && <p className="cc-workspace-source-note">Higher sources take precedence for each section. Source policies can change the selected answer.</p>}
          </section>
          {onConnectAgent && <section className="cc-workspace-connect"><h3>Use this in your agent</h3><p>Bring source-backed context into your coding workflow.</p><button className="cc-workspace-link" type="button" onClick={onConnectAgent}>Connect an agent <span aria-hidden="true">↗</span></button></section>}
        </aside>
      </div>
    </div>
  )
}

export const Overview = memo(OverviewInner)
