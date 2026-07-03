import { C, css, lc, MONO } from '../theme'
import { layerLevel, layerName } from '../data'
import { LayerChip } from '../components/LayerChip'
import { useStore } from '../store'

export function Conflicts() {
  const { conflicts, selConflict, setSelConflict, resolveConflict } = useStore()
  const selConf = conflicts.find((c) => c.id === selConflict) || null

  return (
    <div style={css('display:grid; grid-template-columns:326px minmax(0,1fr); gap:20px; align-items:start;')}>
      <div style={css('display:flex; flex-direction:column; gap:9px;')}>
        {conflicts.map((c) => {
          const selected = c.id === selConflict
          const open = c.status === 'open'
          return (
            <button
              key={c.id}
              className="cc-h-bd-strong"
              onClick={() => setSelConflict(c.id)}
              style={css(`display:block; width:100%; text-align:left; padding:14px 15px; background:${selected ? '#FFFFFF' : C.surface}; border:1px solid ${selected ? C.lineStrong : C.line}; border-left:4px solid ${open ? C.amberStrokeE : C.tealStroke}; border-radius:11px; cursor:pointer; font:inherit; ${selected ? 'box-shadow:0 2px 10px rgba(26,25,21,0.06);' : ''}`)}
            >
              <div style={css('display:flex; align-items:center; justify-content:space-between; gap:8px;')}>
                <code style={css(`font-family:${MONO}; font-size:11px; color:#57564F;`)}>{c.concept}</code>
                <span style={css(`font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; ${open ? `background:${C.amberFill}; color:${C.amberText}; border:1px solid ${C.amberStroke};` : `background:${C.tealFill}; color:${C.tealText}; border:1px solid ${C.tealStroke};`}`)}>{open ? 'open' : 'resolved'}</span>
              </div>
              <div style={css('font-weight:600; font-size:13.5px; margin-top:6px; line-height:1.3;')}>{c.title}</div>
              <div style={css('display:flex; align-items:center; gap:6px; margin-top:9px;')}>
                <span style={css('font-size:11px; color:#8A8A82;')}>§ {c.section.replace(/\s*\{#.*\}/, '')}</span>
                <div style={css('display:flex; gap:4px; margin-left:auto;')}>
                  {c.contributions.map((k) => <LayerChip key={k.layer} id={k.layer} />)}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {selConf && (() => {
        const winnerName = layerName(selConf.winner)
        const loser = selConf.contributions.find((k) => k.layer !== selConf.winner)!
        const loserName = layerName(loser.layer)
        const ordered = selConf.contributions.slice().sort((a, b) => layerLevel(b.layer) - layerLevel(a.layer))
        return (
          <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:14px; padding:24px; min-width:0;')}>
            <div style={css('display:flex; align-items:center; gap:10px;')}>
              <code style={css(`font-family:${MONO}; font-size:12px; color:#3D6E9E; background:#EAF3FC; border:1px solid #C6DEF6; padding:3px 9px; border-radius:6px;`)}>{selConf.concept}</code>
              <code style={css(`font-family:${MONO}; font-size:12px; color:#57564F;`)}>§ {selConf.section}</code>
            </div>
            <h2 style={css('margin:14px 0 4px; font-size:20px; font-weight:600; letter-spacing:-0.01em;')}>{selConf.title}</h2>
            <p style={css('margin:0 0 20px; font-size:13px; color:#57564F; line-height:1.5;')}>Two layers define this section differently. The higher layer is served as effective; the lower rides along as provenance. Resolve to lock the intent.</p>

            <div style={css(`display:grid; grid-template-columns:repeat(${selConf.contributions.length},1fr); gap:12px;`)}>
              {ordered.map((k) => {
                const col = lc(k.layer)
                const isW = k.layer === selConf.winner
                return (
                  <div key={k.layer} style={css(`padding:16px; border-radius:11px; background:${isW ? col.fill : '#FFFFFF'}; border:${isW ? '1.5px' : '1px'} solid ${isW ? C.tealStroke : C.line};`)}>
                    <div style={css('display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:11px;')}>
                      <div style={css('display:flex; align-items:center; gap:8px;')}>
                        <span style={css(`display:grid; place-items:center; width:24px; height:24px; border-radius:999px; background:#FFFFFF; border:2px solid ${col.strokeE}; color:${col.text}; font-family:${MONO}; font-weight:600; font-size:11px;`)}>{layerLevel(k.layer)}</span>
                        <span style={css(`font-weight:600; font-size:13.5px; color:${col.text};`)}>{layerName(k.layer)}</span>
                      </div>
                      {isW && (
                        <span style={css(`font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.08em; padding:3px 8px; background:#2C8A82; color:var(--cc-on-teal); border-radius:999px;`)}>EFFECTIVE</span>
                      )}
                    </div>
                    <div style={css(`font-size:13.5px; color:#1A1915; line-height:1.5; font-weight:${isW ? 600 : 400};`)}>{k.value}</div>
                    <div style={css(`display:flex; align-items:center; gap:8px; margin-top:12px; font-size:11px; color:#8A8A82; font-family:${MONO};`)}>
                      <span>updated {k.updated}</span>
                      {k.note && <><span style={{ color: '#C3C1B8' }}>·</span><span>{k.note}</span></>}
                    </div>
                  </div>
                )
              })}
            </div>

            {selConf.status === 'resolved' && (
              <div style={css('display:flex; align-items:center; gap:11px; margin-top:20px; padding:14px 16px; background:#EAF7F5; border:1px solid #2C8A82; border-radius:11px;')}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--cc-teal-text)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></svg>
                <div style={css('font-size:13px; color:#134F49; line-height:1.4;')}><strong style={css('font-weight:600;')}>Resolved.</strong> {selConf.resolutionText}</div>
              </div>
            )}

            {selConf.status === 'open' && (
              <div style={{ marginTop: 22 }}>
                <div style={css('font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:#8A8A82; margin-bottom:11px;')}>Resolve</div>
                <div style={css('display:grid; grid-template-columns:1fr 1fr; gap:9px;')}>
                  <button className="cc-h-tealfill2" onClick={() => resolveConflict('accept')} style={css('display:flex; flex-direction:column; gap:3px; padding:13px 15px; background:#EAF7F5; border:1px solid #2C8A82; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                    <span style={css('font-weight:600; font-size:13px; color:#134F49;')}>Keep {winnerName} value</span>
                    <span style={css('font-size:11.5px; color:#1E6B64;')}>Confirm the current effective result</span>
                  </button>
                  <button className="cc-h-bd-faint" onClick={() => resolveConflict('promote')} style={css('display:flex; flex-direction:column; gap:3px; padding:13px 15px; background:#FFFFFF; border:1px solid #C3C1B8; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                    <span style={css('font-weight:600; font-size:13px; color:#1A1915;')}>Promote {loserName} value</span>
                    <span style={css('font-size:11.5px; color:#57564F;')}>Override upward, replace effective</span>
                  </button>
                  <button className="cc-h-bd-faint" onClick={() => resolveConflict('override')} style={css('display:flex; flex-direction:column; gap:3px; padding:13px 15px; background:#FFFFFF; border:1px solid #C3C1B8; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                    <span style={css('font-weight:600; font-size:13px; color:#1A1915;')}>Write a personal override</span>
                    <span style={css('font-size:11.5px; color:#57564F;')}>Only you see it, until promoted</span>
                  </button>
                  <button className="cc-h-bd-faint" onClick={() => resolveConflict('annotate')} style={css('display:flex; flex-direction:column; gap:3px; padding:13px 15px; background:#FFFFFF; border:1px solid #C3C1B8; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                    <span style={css('font-weight:600; font-size:13px; color:#1A1915;')}>Annotate both</span>
                    <span style={css('font-size:11.5px; color:#57564F;')}>Keep the tension, add context</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        )
      })()}
    </div>
  )
}
