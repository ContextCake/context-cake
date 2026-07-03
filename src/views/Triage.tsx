import { C, css, badgeStyle, lc, MONO, rc } from '../theme'
import { layerName, layers } from '../data'
import { useStore, type TriageTab } from '../store'

const TAB_DEFS: [TriageTab, string, 'review_required' | 'team_candidate' | 'ignore'][] = [
  ['review', 'Review', 'review_required'],
  ['captured', 'Stored', 'team_candidate'],
  ['ignored', 'Discarded', 'ignore'],
]

export function Triage() {
  const { triageTab, setTriageTab, selSignal, setSelSignal, filtered, signals, setView, route } = useStore()

  const curList = filtered(triageTab)
  const selSig = signals.find((s) => s.id === selSignal) || null

  return (
    <div>
      {/* tabs */}
      <div style={css('display:inline-flex; gap:4px; padding:4px; background:#EAE7DD; border-radius:11px; margin-bottom:18px;')}>
        {TAB_DEFS.map(([id, label, route2]) => {
          const active = triageTab === id
          const count = signals.filter((s) => s.route === route2).length
          return (
            <button
              key={id}
              onClick={() => { const first = filtered(id)[0]; setTriageTab(id); setSelSignal(first ? first.id : null) }}
              style={css(`display:flex; align-items:center; gap:8px; border:none; border-radius:8px; padding:8px 15px; font:inherit; font-weight:${active ? 600 : 500}; font-size:13px; cursor:pointer; background:${active ? '#FBFAF6' : 'transparent'}; color:${active ? C.ink : C.caption}; box-shadow:${active ? '0 1px 2px rgba(26,25,21,0.08)' : 'none'};`)}
            >
              <span>{label}</span>
              <span style={css(`font-family:${MONO}; font-size:11px; color:${active ? C.caption : C.faint};`)}>{count}</span>
            </button>
          )
        })}
      </div>

      <div style={css('display:grid; grid-template-columns:minmax(0,1fr) 400px; gap:20px; align-items:start;')}>
        <div style={css('display:flex; flex-direction:column; gap:11px; min-width:0;')}>
          {curList.length === 0 && (
            <div style={css('display:grid; place-items:center; min-height:220px; border:1px dashed #C3C1B8; border-radius:12px; color:#8A8A82; font-size:13px;')}>Nothing here — inbox zero.</div>
          )}
          {curList.map((s) => {
            const r = rc(s.route)
            const selected = s.id === selSignal
            const col = s.landLayer ? lc(s.landLayer) : null
            return (
              <button
                key={s.id}
                className="cc-h-bd-strong"
                onClick={() => setSelSignal(s.id)}
                style={css(`display:block; width:100%; text-align:left; padding:15px 16px; background:${selected ? '#FFFFFF' : C.surface}; border:1px solid ${selected ? C.lineStrong : C.line}; border-left:4px solid ${r.accent}; border-radius:11px; cursor:pointer; font:inherit; ${selected ? 'box-shadow:0 2px 10px rgba(26,25,21,0.06);' : ''}`)}
              >
                <div style={css('display:flex; align-items:flex-start; justify-content:space-between; gap:12px;')}>
                  <h3 style={css('margin:0; font-size:14.5px; font-weight:600; line-height:1.3;')}>{s.title}</h3>
                  <span style={badgeStyle(s.route)}>{r.label}</span>
                </div>
                <div style={css(`display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:#57564F; font-family:${MONO};`)}>
                  <span>{s.repo}</span><span style={{ color: 'var(--cc-line-strong)' }}>/</span><span>{s.source}</span><span style={{ color: 'var(--cc-line-strong)' }}>/</span><span>{s.owner}</span>
                </div>
                <div style={css('display:flex; align-items:center; gap:10px; margin-top:11px; padding-top:11px; border-top:1px solid #EDEAE0;')}>
                  {col && (
                    <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:2px 7px; border-radius:999px; background:${col.fill}; color:${col.text}; border:1px solid ${col.strokeE}; flex:0 0 auto;`)}>{layerName(s.landLayer!)}</span>
                  )}
                  <span style={css('font-size:11.5px; color:#57564F; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{s.reasons[0][1]}</span>
                  {s.conflict && (
                    <span style={css('display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:600; color:#C77D2A;')}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>conflict</span>
                  )}
                  <span style={css(`font-family:${MONO}; font-size:12.5px; font-weight:500; color:#1A1915;`)}>{Math.round(s.confidence * 100)}%</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* decision panel */}
        <aside style={css('position:sticky; top:88px; display:flex; flex-direction:column; gap:0;')}>
          {selSig ? (() => {
            const r = rc(selSig.route)
            return (
              <div style={css(`background:#FBFAF6; border:1px solid ${C.line}; border-top:4px solid ${r.accent}; border-radius:14px; padding:22px;`)}>
                <span style={badgeStyle(selSig.route)}>{r.label}</span>
                <h2 style={css('margin:12px 0 0; font-size:18px; font-weight:600; line-height:1.25;')}>{selSig.title}</h2>
                <div style={css(`display:flex; align-items:center; gap:8px; margin-top:9px; font-size:12px; color:#57564F; font-family:${MONO};`)}>
                  <span>{selSig.repo}</span><span style={{ color: 'var(--cc-line-strong)' }}>·</span><span>{selSig.source}</span><span style={{ color: 'var(--cc-line-strong)' }}>·</span><span style={css('font-weight:500; color:#1A1915;')}>{Math.round(selSig.confidence * 100)}% confident</span>
                </div>

                <div style={{ marginTop: 18 }}>
                  <div style={css('font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:#8A8A82; margin-bottom:9px;')}>Why it routed here</div>
                  <div style={css('display:flex; flex-direction:column; gap:7px;')}>
                    {selSig.reasons.map(([code, text], i) => {
                      const warn = code.startsWith('review') || code.startsWith('personal')
                      return (
                        <div key={i} style={css('display:flex; align-items:flex-start; gap:9px;')}>
                          <code style={css(`flex:0 0 auto; font-family:${MONO}; font-size:11px; padding:2px 7px; background:${warn ? C.amberFill : C.blueFill}; color:${warn ? C.amberText : C.blueText}; border:1px solid ${warn ? C.amberSoft : C.blueFill3}; border-radius:6px; white-space:nowrap;`)}>{code}</code>
                          <span style={css('font-size:12.5px; color:#3A3934; line-height:1.4;')}>{text}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {selSig.landLayer && (
                  <div style={{ marginTop: 18 }}>
                    <div style={css('font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:#8A8A82; margin-bottom:9px;')}>Where it lands</div>
                    <div style={css('display:flex; flex-direction:column; gap:6px;')}>
                      {(['company', 'team', 'personal'] as const).map((id) => {
                        const L = layers.find((x) => x.id === id)!
                        const col = lc(id)
                        const isT = selSig.landLayer === id
                        return (
                          <div key={id} style={css(`display:flex; align-items:center; gap:11px; padding:9px 12px; background:${isT ? col.fill : '#FFFFFF'}; border:1px solid ${isT ? col.stroke : C.line}; border-radius:9px;`)}>
                            <div style={css(`display:grid; place-items:center; width:26px; height:26px; border-radius:999px; background:${isT ? '#FFFFFF' : C.surface}; border:2px solid ${isT ? col.strokeE : C.line}; color:${isT ? col.text : C.faint}; font-family:${MONO}; font-weight:600; font-size:12px; flex:0 0 auto;`)}>{L.level}</div>
                            <span style={css(`font-weight:${isT ? 600 : 500}; font-size:13px; color:${isT ? col.text : C.faint};`)}>{L.name}</span>
                            {isT && <code style={css(`margin-left:auto; font-family:${MONO}; font-size:11px; color:${col.text};`)}>{selSig.landPath}</code>}
                          </div>
                        )
                      })}
                    </div>
                    <p style={css('margin:10px 0 0; font-size:12px; color:#57564F; line-height:1.5;')}>{selSig.preview}</p>
                  </div>
                )}

                {selSig.conflict && (
                  <button className="cc-h-bd-amber2" onClick={() => setView('conflicts')} style={css('display:flex; align-items:center; gap:9px; width:100%; margin-top:16px; padding:11px 13px; background:#FBF0DD; border:1px solid #D69A3F; border-radius:9px; cursor:pointer; font:inherit; text-align:left;')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                    <span style={css('flex:1; font-size:12.5px; color:#5A3D12; line-height:1.35;')}><strong style={css('font-weight:600;')}>Conflicts with an existing value.</strong> Resolve before storing.</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </button>
                )}

                <div style={css('display:flex; flex-direction:column; gap:8px; margin-top:20px; padding-top:18px; border-top:1px solid #E4E1D6;')}>
                  <button className="cc-h-tealfill2" onClick={() => route('team_candidate')} style={css('display:flex; align-items:center; gap:10px; padding:12px 14px; background:#EAF7F5; border:1px solid #2C8A82; border-radius:9px; cursor:pointer; font:inherit; font-weight:600; font-size:13px; color:#134F49; text-align:left;')}>
                    <span style={css(`font-family:${MONO}; font-size:11px; padding:2px 6px; background:#FFFFFF; border:1px solid #BEE7E1; border-radius:5px;`)}>S</span>Store to shared context
                    <svg style={{ marginLeft: 'auto' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                  </button>
                  <div style={css('display:grid; grid-template-columns:1fr 1fr; gap:8px;')}>
                    <button className="cc-h-bd-faint" onClick={() => route('review_required')} style={css(`display:flex; align-items:center; gap:8px; padding:11px 12px; background:#FBFAF6; border:1px solid #C3C1B8; border-radius:9px; cursor:pointer; font:inherit; font-weight:500; font-size:12.5px; color:#3A3934;`)}><span style={css(`font-family:${MONO}; font-size:11px; padding:2px 6px; background:#F1EFE7; border:1px solid #D8D6CC; border-radius:5px;`)}>R</span>Keep in review</button>
                    <button className="cc-h-bd-faint" onClick={() => route('ignore')} style={css(`display:flex; align-items:center; gap:8px; padding:11px 12px; background:#FBFAF6; border:1px solid #C3C1B8; border-radius:9px; cursor:pointer; font:inherit; font-weight:500; font-size:12.5px; color:#3A3934;`)}><span style={css(`font-family:${MONO}; font-size:11px; padding:2px 6px; background:#F1EFE7; border:1px solid #D8D6CC; border-radius:5px;`)}>D</span>Discard</button>
                  </div>
                </div>
              </div>
            )
          })() : (
            <div style={css('display:grid; place-items:center; min-height:300px; background:#FBFAF6; border:1px solid #D8D6CC; border-radius:13px; color:#8A8A82; font-size:13px;')}>Select a signal to decide.</div>
          )}
        </aside>
      </div>
    </div>
  )
}
