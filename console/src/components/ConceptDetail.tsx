import { C, css, lc, MONO, conceptTypeStyle } from '../theme'
import { layerName } from '../data'
import type { Concept } from '../data'
import { LayerChip } from './LayerChip'

/** The resolved read of a concept — provenance chips per section + inline dissent.
 *  Shared by the Concepts view and the Canvas node slide-over. */
export function ConceptDetail({ concept }: { concept: Concept }) {
  return (
    <>
      <div style={css('display:flex; align-items:center; gap:10px;')}>
        <span style={conceptTypeStyle(concept.type)}>{concept.type}</span>
        <code style={css(`font-family:${MONO}; font-size:12px; color:#57564F;`)}>{concept.id}</code>
      </div>
      <h2 style={css('margin:13px 0 12px; font-size:22px; font-weight:600; letter-spacing:-0.01em;')}>{concept.title}</h2>
      <div style={css('display:flex; align-items:center; gap:10px; padding-bottom:18px; margin-bottom:4px; border-bottom:1px solid #E4E1D6;')}>
        <span style={css('font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:#8A8A82;')}>Resolved from</span>
        <div style={css('display:flex; gap:5px;')}>
          {concept.layers.map((l) => <LayerChip key={l} id={l} />)}
        </div>
        <span style={css(`margin-left:auto; font-size:11.5px; color:#57564F; font-family:${MONO};`)}>{concept.sections.length} sections</span>
      </div>

      <div style={css('display:flex; flex-direction:column;')}>
        {concept.sections.map((s) => {
          const col = lc(s.winner)
          const dissents = s.dissents && s.dissents.length > 0 ? s.dissents : (s.dissent ? [s.dissent] : [])
          const provenance = `${layerName(s.winner)}${s.updated ? ' · ' + s.updated : ''}`
          return (
            <div key={s.key ?? s.name} style={css('padding:16px 0; border-bottom:1px solid #EDEAE0;')}>
              <div style={css('display:flex; align-items:center; gap:9px; margin-bottom:8px;')}>
                <span aria-hidden="true" style={css(`flex:0 0 auto; width:10px; height:10px; border-radius:3px; background:${col.strokeE};`)} />
                <h3 style={css('margin:0; font-size:14px; font-weight:600;')}>{s.name}</h3>
                <span style={css(`margin-left:auto; flex:0 0 auto; font-family:${MONO}; font-size:10.5px; color:${col.text2};`)}>{provenance}</span>
              </div>

              {s.suppressed ? (
                <div style={css('display:flex; align-items:center; gap:7px; font-size:12px; color:#8A8A82;')}>
                  <span aria-hidden="true">▢</span>
                  <span>suppressed by {layerName(s.winner)}</span>
                </div>
              ) : (
                <div style={css('font-size:13.5px; color:#1A1915; line-height:1.55;')}>{s.value}</div>
              )}

              {dissents.length > 0 && (
                <div style={css('display:flex; flex-direction:column; gap:6px; margin-top:10px;')}>
                  {dissents.map((d, i) => {
                    const dc = lc(d.layer)
                    return (
                      <div key={`${d.layer}-${i}`} style={css('display:flex; align-items:flex-start; gap:9px; padding:10px 12px; background:#FBF0DD; border:1px solid #E8C88C; border-radius:9px;')}>
                        <svg style={{ flex: '0 0 auto', marginTop: 1 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2.2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                        <div style={css('flex:1; font-size:12px; color:#5A3D12; line-height:1.45;')}>
                          <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:1px 6px; border-radius:999px; background:#FFFFFF; color:${dc.text}; border:1px solid ${dc.strokeE}; margin-right:2px;`)}>{layerName(d.layer)}</span> says <span style={{ color: 'var(--cc-amber-text2)' }}>"{d.value}"</span> — overridden here.
                        </div>
                        {d.updated && <span style={css(`flex:0 0 auto; font-family:${MONO}; font-size:10px; color:${C.amberText2};`)}>{d.updated}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
