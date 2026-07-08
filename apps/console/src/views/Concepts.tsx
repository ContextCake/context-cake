import { C, css, conceptTypeStyle, MONO } from '../theme'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { useStore } from '../store'

export function Concepts() {
  const { query, selConcept, setSelConcept, concepts } = useStore()
  const q = query.trim().toLowerCase()
  const list = concepts.filter((c) => !q || `${c.title} ${c.id}`.toLowerCase().includes(q))
  const selCpt = concepts.find((c) => c.id === selConcept) || null

  return (
    <div style={css('display:grid; grid-template-columns:310px minmax(0,1fr); gap:20px; align-items:start;')}>
      <div style={css('display:flex; flex-direction:column; gap:8px;')}>
        {list.map((c) => {
          const selected = c.id === selConcept
          return (
            <button
              key={c.id}
              className="cc-h-bd-strong"
              onClick={() => setSelConcept(c.id)}
              style={css(`display:block; width:100%; text-align:left; padding:14px 15px; background:${selected ? '#FFFFFF' : C.surface}; border:1px solid ${selected ? C.lineStrong : C.line}; border-radius:11px; cursor:pointer; font:inherit; ${selected ? 'box-shadow:0 2px 10px rgba(26,25,21,0.06);' : ''}`)}
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
        <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:14px; padding:24px; min-width:0;')}>
          <ConceptDetail concept={selCpt} />
        </section>
      )}
    </div>
  )
}
