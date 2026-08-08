import { memo, useEffect, useRef, useState } from 'react'
import { C, css, conceptTypeStyle, MONO } from '../theme'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { useDetailSurface } from '../components/useDetailSurface'
import { useStoreData, useStoreInput, useStoreNav } from '../store'
import type { Concept } from '../data'
import type { SearchHit } from '../types'

/** How long a keystroke waits before it becomes an /api/search request. */
const SEARCH_DEBOUNCE_MS = 250

function ConceptsInner() {
  const { setSelConcept, concepts, mode, search } = useStoreData()
  const { selConcept } = useStoreNav()
  const { query } = useStoreInput()
  const q = query.trim().toLowerCase()
  const substringList = concepts.filter((c) => !q || `${c.title} ${c.id}`.toLowerCase().includes(q))

  // Engine full-text search (live mode only). `null` means "no answer to show
  // yet" — either nothing has been typed, the debounced request is still in
  // flight, or the engine failed/is too old — and the substring filter above
  // is what renders in every one of those cases. A non-null array (possibly
  // empty) is the engine's own answer and takes over the list.
  const [engineHits, setEngineHits] = useState<SearchHit[] | null>(null)
  useEffect(() => {
    if (mode !== 'live' || !q) { setEngineHits(null); return }
    let cancelled = false
    const timer = setTimeout(() => {
      void search(query.trim()).then((hits) => { if (!cancelled) setEngineHits(hits) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [mode, q, query, search])

  // A hit for a concept not in the loaded list is skipped rather than
  // rendered as a dead row — resolve-all supplies the full set, so this only
  // happens for a concept still resolving in the background.
  const usingEngine = mode === 'live' && q !== '' && engineHits !== null
  const list = usingEngine
    ? engineHits.reduce<Concept[]>((acc, hit) => {
        const match = concepts.find((c) => c.id === hit.id)
        if (match) acc.push(match)
        return acc
      }, [])
    : substringList
  const selCpt = concepts.find((c) => c.id === selConcept) || null
  const [detailOpen, setDetailOpen] = useState(Boolean(selConcept))
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)
  useEffect(() => {
    const close = () => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }
    window.addEventListener('contextcake:close-detail', close)
    return () => window.removeEventListener('contextcake:close-detail', close)
  }, [])

  if (concepts.length === 0) return <div className="cc-ui-empty"><strong>No concepts yet</strong><p>Add or index a source to build the resolved cascade.</p></div>
  if (list.length === 0) {
    return (
      <div className="cc-ui-empty">
        <strong>No matching concepts</strong>
        <p>{usingEngine ? 'No matches in titles or content.' : 'Try a title, concept ID, or type.'}</p>
      </div>
    )
  }

  return (
    <div ref={detail.containerRef} className="cc-navigator-detail" style={css('display:grid; grid-template-columns:minmax(240px,280px) minmax(0,1fr); gap:12px; align-items:start;')}>
      <div style={css('display:flex; flex-direction:column; gap:8px;')}>
        {list.map((c) => {
          const selected = c.id === selConcept
          return (
            <button
              key={c.id}
              className="cc-h-bd-strong"
              aria-current={selected ? 'true' : undefined}
              onClick={(event) => { selectedButton.current = event.currentTarget; setSelConcept(c.id); setDetailOpen(true) }}
              style={css(`display:block; width:100%; text-align:left; padding:14px 15px; background:${selected ? C.tealFill : C.surface}; border:1px solid ${selected ? C.tealStroke : C.line}; border-radius:10px; cursor:pointer; font:inherit;`)}
            >
              <div style={css('display:flex; align-items:center; gap:8px;')}>
                <span style={conceptTypeStyle(c.type)}>{c.type}</span>
                {c.conflict && <span title="has conflict" style={css('width:7px; height:7px; border-radius:999px; background:#C77D2A;')} />}
                {c.draft && <span style={css(`font-size:10px; font-family:${MONO}; color:#7A5A28;`)}>draft</span>}
                {/* No sections to read — a dead end worth flagging here so it's
                    triageable from the list, not only discovered by opening it. */}
                {c.sections.length === 0 && <span title="This concept has no sections" style={css(`font-size:10px; font-family:${MONO}; color:#8A8A82;`)}>empty</span>}
              </div>
              <div style={css('font-weight:600; font-size:13.5px; margin-top:7px;')}>{c.title}</div>
              <code style={css(`display:block; font-family:${MONO}; font-size:11px; color:#8A8A82; margin-top:3px;`)}>{c.id}</code>
              <div style={css('display:flex; gap:4px; margin-top:9px;')}>
                {c.layers.map((l) => <LayerChip key={l} id={l} />)}
              </div>
            </button>
          )
        })}
      </div>

      {selCpt && (
        <section ref={detail.panelRef} {...detail.panelProps} aria-label={`${selCpt.title} concept detail`} className="cc-navigator-detail-panel" data-open={detailOpen || undefined} style={css(`background:${C.surface}; border:1px solid ${C.line}; border-radius:10px; padding:24px; min-width:0;`)}>
          <button type="button" className="cc-detail-close" onClick={() => { setDetailOpen(false); requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true })) }}>Close</button>
          <ConceptDetail concept={selCpt} />
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
