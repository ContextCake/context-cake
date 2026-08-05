import { useEffect, useRef, useState } from 'react'
import { C, css, conceptTypeStyle, MONO } from '../theme'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { useDetailSurface } from '../components/useDetailSurface'
import { useStore } from '../store'

export function Concepts() {
  const { query, selConcept, setSelConcept, concepts } = useStore()
  const q = query.trim().toLowerCase()
  const list = concepts.filter((c) => !q || `${c.title} ${c.id}`.toLowerCase().includes(q))
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
  if (list.length === 0) return <div className="cc-ui-empty"><strong>No matching concepts</strong><p>Try a title, concept ID, or type.</p></div>

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
