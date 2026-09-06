import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { C, css, conceptTypeStyle, MONO } from '../theme'
import { useVirtualWindow } from '../components/useVirtualWindow'
import { ConceptDetail } from '../components/ConceptDetail'
import { useDetailSurface } from '../components/useDetailSurface'
import { useStoreData, useStoreInput, useStoreNav } from '../store'
import type { SearchHit } from '../types'

/** How long a keystroke waits before it becomes an /api/search request. */
const SEARCH_DEBOUNCE_MS = 250

function ConceptsInner() {
  const { setSelConcept, concepts, mode, search, sources } = useStoreData()
  const { selConcept } = useStoreNav()
  const { query } = useStoreInput()
  const q = query.trim().toLowerCase()
  const substringList = concepts.filter((c) => !q || `${c.title} ${c.id}`.toLowerCase().includes(q))

  const [answer, setAnswer] = useState<{ query: string; sourceVersion: string; hits: SearchHit[] | null; failed: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const [sourceFilter, setSourceFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const liveQuery = mode === 'live' && Boolean(q)
  const sourceVersion = JSON.stringify(sources.map((source) => [source.name, source.conceptCount, source.status, source.lastSuccessAt, source.indexing?.refreshing]))
  const pending = liveQuery && (answer?.query !== q || answer?.sourceVersion !== sourceVersion)
  useEffect(() => {
    if (!liveQuery) return
    let cancelled = false
    const timer = setTimeout(() => {
      const settle = (hits: SearchHit[] | null) => { if (!cancelled) setAnswer((previous) => ({ query: q, sourceVersion, hits: hits ?? (previous?.query === q ? previous.hits : null), failed: hits === null })) }
      void search(q).then(settle).catch(() => settle(null))
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [liveQuery, q, sourceVersion, search, retry])
  const engineHits = answer?.query === q ? answer.hits : null
  const usingEngine = liveQuery && engineHits !== null
  const failed = liveQuery && !pending && answer?.failed === true
  const partial = sources.some((source) => source.status === 'indexing' || source.status === 'error' || source.status === 'degraded' || source.indexing?.refreshing || Boolean(source.warnings))
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts])
  const hitsById = new Map((engineHits ?? []).map((hit) => [hit.id, hit]))
  const ranked = (engineHits ?? []).flatMap((hit) => byId.has(hit.id) ? [byId.get(hit.id)!] : [])
  const rankedIds = new Set(ranked.map((c) => c.id))
  const merged = usingEngine ? [...ranked, ...substringList.filter((c) => !rankedIds.has(c.id))] : substringList
  const list = merged.filter((c) => (!sourceFilter || c.contributorLayers?.includes(sourceFilter)) && (!typeFilter || c.type === typeFilter))
  const rankedCount = list.filter((c) => rankedIds.has(c.id)).length
  const showMatchDivider = rankedCount > 0 && rankedCount < list.length
  const [activeId, setActiveId] = useState(selConcept)
  const activeIndex = Math.max(0, list.findIndex((c) => c.id === activeId))
  const rowSizes = list.map((c) => hitsById.get(c.id)?.snippet ? 190 : 142).join(',')
  const heights = useMemo(() => rowSizes ? rowSizes.split(',').map(Number) : [], [rowSizes])
  const virtual = useVirtualWindow(heights, { activeIndex })
  useEffect(() => { virtual.scrollRef.current?.scrollTo?.(0, 0) }, [q, sourceFilter, typeFilter])
  const [detailOpen, setDetailOpen] = useState(Boolean(selConcept))
  const [detailQuery, setDetailQuery] = useState(q)
  const selCpt = detailQuery === q ? concepts.find((c) => c.id === selConcept) || null : null
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const previousQuery = useRef(q)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)
  useEffect(() => {
    if (previousQuery.current === q) return
    previousQuery.current = q
    setDetailOpen(false)
    selectedButton.current = null
    setSelConcept('')
  }, [q, setSelConcept])
  useEffect(() => {
    const close = () => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }
    window.addEventListener('contextcake:close-detail', close)
    return () => window.removeEventListener('contextcake:close-detail', close)
  }, [])

  if (concepts.length === 0) return <div className="cc-ui-empty"><strong>No concepts yet</strong><p>Add or index a source to build the resolved cascade.</p></div>

  return (
    <div ref={detail.containerRef} className="cc-navigator-detail" style={css('display:grid; grid-template-columns:minmax(240px,280px) minmax(0,1fr); gap:12px; align-items:start;')}>
      <div className="cc-concept-results">
        <div className="cc-search-filters">
          <select aria-label="Filter concepts by source" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}><option value="">All sources</option>{sources.map((source) => <option key={source.name} value={source.name}>{source.name}</option>)}</select>
          <select aria-label="Filter concepts by type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="">All types</option>{[...new Set(concepts.map((c) => c.type))].sort().map((type) => <option key={type}>{type}</option>)}</select>
        </div>
        <div className="cc-search-state" role="status">
          {pending ? (usingEngine ? 'Refreshing content matches… Showing the last search result.' : 'Searching content… Title matches shown while you wait.') : failed ? (usingEngine ? 'Content search unavailable. Showing the last successful results.' : 'Content search unavailable. Showing title matches only.') : `${list.length} result${list.length === 1 ? '' : 's'}${usingEngine ? ' · relevance first, then title matches' : ''}`}
          {failed && <button type="button" onClick={() => { setAnswer(null); setRetry((n) => n + 1) }}>Retry search</button>}
          {partial && <span>Sources are still indexing or unavailable; results may be incomplete.</span>}
          {usingEngine && <span>Up to 20 ranked content matches. Narrow your query for more specific results.</span>}
        </div>
        {list.length === 0 && <div className="cc-ui-empty"><strong>{pending ? 'Searching your sources…' : failed ? 'No title matches' : partial ? 'No matches in available context' : 'No matching concepts'}</strong><p>{pending ? 'Content results will appear here.' : usingEngine ? 'No matches in titles or content.' : 'Try a title, concept ID, or type.'}</p></div>}
        <div ref={virtual.scrollRef} onScroll={virtual.onScroll} className="cc-concept-window" aria-label="Concept results" aria-busy={pending}>
        <div style={{ height: virtual.totalHeight, position: 'relative' }}>
        {virtual.indices.map((i) => {
          const c = list[i]
          const hit = hitsById.get(c.id)
          const selected = c.id === selConcept
          return (
            <button
              key={c.id}
              className="cc-h-bd-strong cc-concept-result"
              tabIndex={i === activeIndex ? 0 : -1}
              onFocus={() => setActiveId(c.id)}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))
                setActiveId(list[next].id); virtual.ensureVisible(next)
                requestAnimationFrame(() => virtual.scrollRef.current?.querySelector<HTMLButtonElement>(`[data-result-index="${next}"]`)?.focus())
              }}
              data-result-index={i}
              aria-current={selected ? 'true' : undefined}
              onClick={(event) => { selectedButton.current = event.currentTarget; setSelConcept(c.id); setDetailQuery(q); setDetailOpen(true) }}
              style={css(`position:absolute; top:${virtual.offsetOf(i)}px; height:${heights[i] - 8}px; overflow:hidden; display:block; width:100%; text-align:left; padding:12px 14px; background:${selected ? C.tealFill : C.surface}; border:1px solid ${selected ? C.tealStroke : C.line}; border-radius:10px; cursor:pointer; font:inherit;`)}
            >
              {showMatchDivider && (i === 0 || i === rankedCount) && <span className="cc-result-group">{i === 0 ? 'Top matches' : 'Also contains'}</span>}
              <div style={css('display:flex; align-items:center; gap:8px;')}>
                <span style={conceptTypeStyle(c.type)}>{c.type}</span>
                {c.conflict && <span title="has conflict" style={css('width:7px; height:7px; border-radius:999px; background:#C77D2A;')} />}
                {c.draft && <span style={css(`font-size:10px; font-family:${MONO}; color:#7A5A28;`)}>draft</span>}
                {/* No sections to read — a dead end worth flagging here so it's
                    triageable from the list, not only discovered by opening it.
                    Only a LOADED row can make that claim: a compact graph-first
                    row (detailLoaded false) merely hasn't fetched its document. */}
                {c.detailLoaded !== false && c.sections.length === 0 && <span title="This concept has no sections" style={css(`font-size:10px; font-family:${MONO}; color:#8A8A82;`)}>empty</span>}
              </div>
              <div className="cc-result-title">{c.title}</div>
              <code className="cc-result-id">{c.id}</code>
              {hit?.snippet && <p className="cc-result-snippet">{hit.snippet}</p>}
              <div className="cc-result-sources">{(hit?.layers ?? c.contributorLayers ?? c.layers).join(' · ')}</div>
              {c.sections[0]?.updated && <time className="cc-result-date">Section updated {c.sections[0].updated}</time>}
            </button>
          )
        })}
        </div></div>
      </div>

      {selCpt && (
        <section ref={detail.panelRef} {...detail.panelProps} aria-label={`${selCpt.title} concept detail`} className="cc-navigator-detail-panel" data-open={detailOpen || undefined} style={css(`background:${C.surface}; border:1px solid ${C.line}; border-radius:10px; padding:24px; min-width:0;`)}>
          <button type="button" className="cc-detail-close" onClick={() => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }}>Close</button>
          <ConceptDetail key={selCpt.id} concept={selCpt} matchQuery={q} />
        </section>
      )}
    </div>
  )
}

/**
 * Memoized. The shell re-renders for its own reasons — a drawer, a dialog, a
 * background-activity tick — and this view has no business repainting for any
 * of them. It re-renders when the store slices it subscribes to change, and
 * otherwise not at all.
 */
export const Concepts = memo(ConceptsInner)
