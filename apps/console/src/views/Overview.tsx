import { C, css, lc, MONO } from '../theme'
import { layerName, layers } from '../data'
import { useStore } from '../store'

export function Overview() {
  const { setView, signals, conflicts, sources, concepts, activity } = useStore()
  const openConflicts = conflicts.filter((c) => c.status === 'open').length
  const triageCount = signals.filter((s) => s.route === 'review_required').length

  const statTiles = [
    { label: 'Sources', value: String(sources.length), unit: 'feeding', accent: C.tealStroke, numColor: C.ink },
    { label: 'Concepts', value: String(concepts.length), unit: 'resolved', accent: C.blueStroke, numColor: C.ink },
    { label: 'Open conflicts', value: String(openConflicts), unit: 'to resolve', accent: C.amberStrokeE, numColor: C.amberText },
    { label: 'To triage', value: String(triageCount), unit: 'signals', accent: C.amberStroke, numColor: C.amberText },
  ]

  const cakeBands = (['personal', 'team', 'company'] as const).map((id) => {
    const L = layers.find((x) => x.id === id)!
    const col = lc(id)
    const nc = conflicts.filter((c) => c.contributions.some((k) => k.layer === id)).length
    // Real count from the loaded cascade: concepts this layer contributes to.
    const conceptCount = concepts.filter((c) => c.layers.includes(id)).length
    return { id, L, col, nc, conceptCount }
  })

  const statusColor = (s: string) => (s === 'error' ? C.amberStrokeE : s === 'serving' ? C.tealStrokeE : C.blueStroke)
  const kindMap: Record<string, { g: string; l: string }> = {
    mcp: { g: '⇄', l: 'MCP source' }, 'okf-local': { g: '▤', l: 'OKF bundle' },
  }

  return (
    <div style={css('display:flex; flex-direction:column; gap:20px;')}>
      {/* stat tiles */}
      <div style={css('display:grid; grid-template-columns:repeat(auto-fit, minmax(148px, 1fr)); gap:14px;')}>
        {statTiles.map((s) => (
          <div key={s.label} style={css(`padding:16px 18px; background:#FBFAF6; border:1px solid #D8D6CC; border-radius:11px;`)}>
            <div style={css('display:flex; align-items:center; gap:7px;')}>
              <span style={css(`width:8px; height:8px; border-radius:3px; background:${s.accent}; flex:0 0 auto;`)} />
              <div style={css('font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:#8A8A82;')}>{s.label}</div>
            </div>
            <div style={css('display:flex; align-items:baseline; gap:8px; margin-top:6px;')}>
              <div style={css(`font-family:${MONO}; font-size:30px; font-weight:500; letter-spacing:-0.02em; color:${s.numColor};`)}>{s.value}</div>
              <div style={css('font-size:12px; color:#57564F;')}>{s.unit}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={css('display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; align-items:start;')}>
        <div style={css('display:flex; flex-direction:column; gap:20px; min-width:0;')}>
          {/* Cascade */}
          <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:13px; padding:20px;')}>
            <div style={css('display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:4px;')}>
              <h2 style={css('margin:0; font-size:15px; font-weight:600;')}>The cascade</h2>
              <span style={css('font-size:11.5px; color:#57564F;')}>Higher layers win — <em style={css('font-style:normal; color:#1A1915; font-weight:500;')}>per section</em></span>
            </div>
            <p style={css('margin:0 0 16px; font-size:12.5px; color:#57564F;')}>Knowledge resolves top-down. A layer overrides only the sections it speaks to; everything else is inherited from below.</p>
            <div style={css('display:flex; flex-direction:column; gap:9px;')}>
              {cakeBands.map(({ id, L, col, nc, conceptCount }) => (
                <div key={id} style={css(`display:grid; grid-template-columns:44px 1fr auto; align-items:center; gap:14px; padding:14px 16px; background:${col.fill}; border:1.5px solid ${col.stroke}; border-radius:11px;`)}>
                  <div style={css(`display:grid; place-items:center; width:34px; height:34px; border-radius:999px; background:#FFFFFF; border:2px solid ${col.strokeE}; color:${col.text}; font-family:${MONO}; font-weight:600; font-size:15px;`)}>{L.level}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={css('display:flex; align-items:center; gap:9px;')}>
                      <span style={css(`font-weight:600; font-size:14.5px; color:${col.text};`)}>{L.name}</span>
                      <span style={css(`font-size:10.5px; color:${col.text2}; font-family:${MONO};`)}>· {L.members}</span>
                    </div>
                    <div style={css(`font-size:11.5px; color:${col.text2}; margin-top:1px;`)}>{L.sub}</div>
                  </div>
                  <div style={css('display:flex; gap:8px; align-items:center;')}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={css(`font-family:${MONO}; font-size:17px; font-weight:500; color:${col.text}; line-height:1;`)}>{conceptCount}</div>
                      <div style={css(`font-size:9.5px; letter-spacing:0.05em; text-transform:uppercase; color:${col.text2}; margin-top:3px;`)}>concepts</div>
                    </div>
                    {nc > 0 && (
                      <div style={css('display:flex; align-items:center; gap:5px; padding:5px 9px; background:#FBF0DD; border:1px solid #D69A3F; border-radius:999px;')}>
                        <span style={css('width:6px; height:6px; border-radius:999px; background:#C77D2A;')} />
                        <span style={css(`font-size:11px; font-weight:600; color:#5A3D12; font-family:${MONO};`)}>{nc}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Sources */}
          <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:13px; padding:20px;')}>
            <div style={css('display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px;')}>
              <h2 style={css('margin:0; font-size:15px; font-weight:600;')}>Context sources</h2>
              <span style={css('font-size:11.5px; color:#57564F;')}>{sources.length} feeding the graph</span>
            </div>
            <div style={css('display:flex; flex-direction:column; gap:8px;')}>
              {sources.map((s) => {
                const col = lc(s.layer)
                const k = kindMap[s.kind]
                const barColor = s.coverage >= 75 ? C.tealStroke : s.coverage >= 60 ? C.blueStroke : C.amberStroke
                return (
                  <div key={s.name} className="cc-src-row" style={css('padding:9px 12px; background:#FFFFFF; border:1px solid #E4E1D6; border-radius:9px;')}>
                    <span title={k.l} style={css(`display:grid; place-items:center; font-family:${MONO}; font-size:13px; color:${C.caption};`)}>{k.g}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={css(`font-weight:500; font-size:13px; font-family:${MONO}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`)}>{s.name}</div>
                      <div style={css('font-size:11px; color:#8A8A82; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{s.focus}</div>
                    </div>
                    <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:${col.fill}; color:${col.text}; border:1px solid ${col.strokeE}; justify-self:start;`)}>{layerName(s.layer)}</span>
                    <div className="cc-src-cov" style={css('display:flex; align-items:center; gap:8px;')}>
                      <div style={css('flex:1; height:6px; border-radius:999px; background:#ECEAE0; overflow:hidden;')}>
                        <span style={css(`display:block; height:100%; width:${s.coverage}%; background:${barColor}; border-radius:999px;`)} />
                      </div>
                    </div>
                    <div style={css('display:flex; align-items:center; gap:6px; justify-content:flex-end;')}>
                      <span style={css(`width:7px; height:7px; border-radius:999px; background:${statusColor(s.status)};`)} />
                      <span style={css('font-size:11px; color:#57564F;')}>{s.status}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        <div style={css('display:flex; flex-direction:column; gap:20px; min-width:0;')}>
          {/* Needs you */}
          <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:13px; padding:20px;')}>
            <h2 style={css('margin:0 0 14px; font-size:15px; font-weight:600;')}>Needs you</h2>
            <div style={css('display:flex; flex-direction:column; gap:10px;')}>
              <button className="cc-h-bd-amber" onClick={() => setView('triage')} style={css('display:flex; align-items:center; gap:14px; width:100%; text-align:left; padding:14px 15px; background:#FBF0DD; border:1px solid #E8C88C; border-radius:11px; cursor:pointer; font:inherit;')}>
                <div style={css(`font-family:${MONO}; font-size:26px; font-weight:500; color:#5A3D12; line-height:1;`)}>{triageCount}</div>
                <div style={{ flex: 1 }}>
                  <div style={css('font-weight:600; font-size:13.5px; color:#5A3D12;')}>Signals to triage</div>
                  <div style={css('font-size:11.5px; color:#7A5A28;')}>Store, review, or discard</div>
                </div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
              <button className="cc-h-bd-amber2" onClick={() => setView('conflicts')} style={css('display:flex; align-items:center; gap:14px; width:100%; text-align:left; padding:14px 15px; background:#FFFFFF; border:1px solid #E8C88C; border-radius:11px; cursor:pointer; font:inherit;')}>
                <div style={css(`font-family:${MONO}; font-size:26px; font-weight:500; color:#C77D2A; line-height:1;`)}>{openConflicts}</div>
                <div style={{ flex: 1 }}>
                  <div style={css('font-weight:600; font-size:13.5px; color:#1A1915;')}>Unresolved conflicts</div>
                  <div style={css('font-size:11.5px; color:#57564F;')}>Layers disagree on a section</div>
                </div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
          </section>

          {/* Activity — demo-only feed; hidden in live mode (no fake feed) */}
          {activity.length > 0 && (
            <section style={css('background:#FBFAF6; border:1px solid #D8D6CC; border-radius:13px; padding:20px;')}>
              <h2 style={css('margin:0 0 14px; font-size:15px; font-weight:600;')}>Recent activity</h2>
              <div style={css('display:flex; flex-direction:column;')}>
                {activity.map((a, i) => (
                  <div key={i} style={css('display:grid; grid-template-columns:14px 1fr auto; gap:12px; padding:9px 0; border-top:1px solid #EAE7DD;')}>
                    <span style={css(`width:8px; height:8px; border-radius:999px; margin-top:6px; background:${lc(a.layer).strokeE};`)} />
                    <div style={css('font-size:12.5px; color:#3A3934; line-height:1.4;')}>{a.pre}<strong style={css('font-weight:600; color:#1A1915;')}>{a.strong}</strong>{a.post}</div>
                    <div style={css(`font-size:11px; color:#8A8A82; font-family:${MONO}; white-space:nowrap;`)}>{a.time}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
