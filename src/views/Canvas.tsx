import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { C, css, lc, MONO, type LayerId } from '../theme'
import { concepts, layerLevel, layers, type Concept } from '../data'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { useStore } from '../store'

// ---- layout constants (world coordinates) ----
const NODE_W = 214, NODE_H = 96
const GHOST_W = 196, GHOST_H = 66
const GAP_X = 66, START_X = 74
const LANE_TOP = 60, LANE_H = 196, LANE_GAP = 16
const LANE_INNER = LANE_H - LANE_GAP
const NODE_DY = 46, GHOST_DY = 62

// lanes top→bottom: highest precedence (Personal) on top so "up = wins"
const LANE_ORDER: LayerId[] = ['personal', 'team', 'company']
const laneIndex = (id: LayerId) => LANE_ORDER.indexOf(id)
const laneY = (i: number) => LANE_TOP + i * LANE_H
const primaryLayer = (c: Concept): LayerId =>
  c.layers.slice().sort((a, b) => layerLevel(b) - layerLevel(a))[0]

interface NodePos { c: Concept; x: number; y: number; conflict: boolean }
interface GhostPos { key: string; parent: NodePos; layer: LayerId; value: string; x: number; y: number }

function computeLayout() {
  const nodes: NodePos[] = concepts.map((c, i) => {
    const x = START_X + i * (NODE_W + GAP_X)
    const y = laneY(laneIndex(primaryLayer(c))) + NODE_DY
    return { c, x, y, conflict: c.sections.some((s) => s.dissent) }
  })
  const ghosts: GhostPos[] = []
  for (const n of nodes) {
    const seen = new Set<LayerId>()
    for (const s of n.c.sections) {
      if (!s.dissent || seen.has(s.dissent.layer)) continue
      seen.add(s.dissent.layer)
      ghosts.push({
        key: `${n.c.id}:${s.dissent.layer}`, parent: n, layer: s.dissent.layer, value: s.dissent.value,
        x: n.x + (NODE_W - GHOST_W) / 2, y: laneY(laneIndex(s.dissent.layer)) + GHOST_DY,
      })
    }
  }
  const worldW = START_X + concepts.length * (NODE_W + GAP_X)
  const worldH = laneY(LANE_ORDER.length - 1) + LANE_H
  return { nodes, ghosts, worldW, worldH }
}

/** Cubic bezier between two vertically-separated anchor points. */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dy = Math.max(40, (y2 - y1) * 0.5)
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
}

export function Canvas() {
  const { setSelConcept, setSelConflict, setView, conflicts } = useStore()
  const { nodes, ghosts, worldW, worldH } = computeLayout()

  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setViewT] = useState({ tx: 40, ty: 20, scale: 1 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const fit = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const cw = el.clientWidth, ch = el.clientHeight
    const scale = Math.min(1, (cw - 48) / worldW, (ch - 48) / worldH)
    setViewT({ scale, tx: (cw - worldW * scale) / 2, ty: Math.max(24, (ch - worldH * scale) / 2) })
  }, [worldW, worldH])

  useLayoutEffect(() => { fit() }, [fit])

  // native wheel listener so we can preventDefault (zoom toward cursor)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left, py = e.clientY - rect.top
      setViewT((v) => {
        const next = Math.min(2, Math.max(0.4, v.scale * Math.exp(-e.deltaY * 0.0015)))
        const wx = (px - v.tx) / v.scale, wy = (py - v.ty) / v.scale
        return { scale: next, tx: px - wx * next, ty: py - wy * next }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setViewT((v) => ({ ...v, tx: drag.current!.tx + (e.clientX - drag.current!.x), ty: drag.current!.ty + (e.clientY - drag.current!.y) }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null
    setDragging(false)
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  const openConcept = (c: Concept) => { setOpenId(c.id); setSelConcept(c.id) }
  const openConflictFor = (conceptId: string) => {
    const cf = conflicts.find((c) => c.concept === conceptId)
    if (cf) { setSelConflict(cf.id); setView('conflicts') }
  }

  // Escape closes the node slide-over.
  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])
  const zoom = (dir: number) => setViewT((v) => {
    const el = wrapRef.current!, px = el.clientWidth / 2, py = el.clientHeight / 2
    const next = Math.min(2, Math.max(0.4, v.scale * (dir > 0 ? 1.2 : 1 / 1.2)))
    const wx = (px - v.tx) / v.scale, wy = (py - v.ty) / v.scale
    return { scale: next, tx: px - wx * next, ty: py - wy * next }
  })

  const openConceptObj = openId ? concepts.find((c) => c.id === openId) || null : null
  const openHasConflict = openConceptObj ? conflicts.some((c) => c.concept === openConceptObj.id) : false

  return (
    <div style={css('position:relative; height:100%; width:100%; overflow:hidden; background:var(--cc-canvas-bg);')}>
      <div
        ref={wrapRef}
        className="cc-canvas-dots"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ position: 'absolute', inset: 0, cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, width: worldW, height: worldH }}>
          {/* lane backgrounds + labels */}
          {LANE_ORDER.map((id, i) => {
            const L = layers.find((l) => l.id === id)!
            const col = lc(id)
            return (
              <div key={id} style={{ position: 'absolute', left: 0, top: laneY(i), width: worldW, height: LANE_INNER }}>
                <div style={css(`position:absolute; inset:0; background:var(--cc-lane-bg); border:1px solid var(--cc-lane-line); border-radius:16px;`)} />
                <div style={css(`position:absolute; left:18px; top:14px; display:flex; align-items:center; gap:10px;`)}>
                  <span style={css(`display:grid; place-items:center; width:26px; height:26px; border-radius:999px; background:${C.raised}; border:2px solid ${col.strokeE}; color:${col.text}; font-family:${MONO}; font-weight:600; font-size:12px;`)}>{L.level}</span>
                  <div style={{ lineHeight: 1.15 }}>
                    <div style={css(`font-size:13px; font-weight:600; color:${col.text};`)}>{L.name}</div>
                    <div style={css(`font-size:10.5px; color:${C.faint}; font-family:${MONO};`)}>{L.members} · {L.concepts} concepts</div>
                  </div>
                </div>
              </div>
            )
          })}

          {/* edges (SVG overlay) */}
          <svg style={{ position: 'absolute', top: 0, left: 0, width: worldW, height: worldH, overflow: 'visible', pointerEvents: 'none' }}>
            {ghosts.map((g) => {
              const active = hoverId === g.parent.c.id || openId === g.parent.c.id
              return (
                <path
                  key={g.key}
                  d={edgePath(g.parent.x + NODE_W / 2, g.parent.y + NODE_H, g.x + GHOST_W / 2, g.y)}
                  fill="none"
                  stroke="var(--cc-edge-conflict)"
                  strokeWidth={active ? 2.4 : 1.6}
                  strokeDasharray="5 5"
                  opacity={active ? 1 : 0.72}
                />
              )
            })}
          </svg>

          {/* ghost (dissent) cards */}
          {ghosts.map((g) => {
            const col = lc(g.layer)
            return (
              <button
                key={g.key}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => openConflictFor(g.parent.c.id)}
                onMouseEnter={() => setHoverId(g.parent.c.id)}
                onMouseLeave={() => setHoverId(null)}
                title="Layers disagree — open the conflict"
                style={{ position: 'absolute', left: g.x, top: g.y, width: GHOST_W, height: GHOST_H, ...css(`display:flex; flex-direction:column; justify-content:center; gap:4px; text-align:left; padding:10px 12px; background:${C.surface}; border:1px dashed var(--cc-edge-conflict); border-radius:11px; cursor:pointer; font:inherit;`) }}
              >
                <div style={css('display:flex; align-items:center; gap:7px;')}>
                  <LayerChip id={g.layer} />
                  <span style={css(`font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:${C.amberStrokeE};`)}>overridden</span>
                </div>
                <div style={css(`font-size:11.5px; color:${col.text2}; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`)}>{g.value}</div>
              </button>
            )
          })}

          {/* concept nodes */}
          {nodes.map((n) => {
            const col = lc(primaryLayer(n.c))
            const selected = openId === n.c.id
            const glow = selected ? `0 0 0 2px ${col.strokeE}, 0 10px 30px var(--cc-node-glow)` : `0 2px 10px var(--cc-shadow)`
            return (
              <button
                key={n.c.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => openConcept(n.c)}
                onMouseEnter={() => setHoverId(n.c.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{ position: 'absolute', left: n.x, top: n.y, width: NODE_W, height: NODE_H, boxShadow: glow, ...css(`display:flex; flex-direction:column; gap:0; text-align:left; padding:12px 14px; background:${C.raised}; border:1px solid ${selected ? col.strokeE : C.line}; border-left:3px solid ${col.strokeE}; border-radius:12px; cursor:pointer; font:inherit;`) }}
              >
                <div style={css('display:flex; align-items:center; gap:8px;')}>
                  <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 7px; border-radius:6px; color:${col.text}; border:1px solid ${col.strokeE}; background:${col.fill};`)}>{n.c.type}</span>
                  {n.conflict && (
                    <span style={css(`display:inline-flex; align-items:center; gap:4px; margin-left:auto; font-size:9.5px; font-weight:600; color:${C.amberStrokeE};`)}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>conflict
                    </span>
                  )}
                  {n.c.draft && !n.conflict && <span style={css(`margin-left:auto; font-size:10px; font-family:${MONO}; color:${C.amberText2};`)}>draft</span>}
                </div>
                <div style={css(`font-weight:600; font-size:13.5px; margin-top:9px; color:${C.ink}; line-height:1.25;`)}>{n.c.title}</div>
                <code style={css(`font-family:${MONO}; font-size:10.5px; color:${C.faint}; margin-top:auto;`)}>{n.c.id}</code>
              </button>
            )
          })}
        </div>
      </div>

      {/* legend */}
      <div style={css(`position:absolute; left:20px; bottom:20px; display:flex; flex-direction:column; gap:8px; padding:12px 14px; background:var(--cc-header-bg); backdrop-filter:blur(10px); border:1px solid ${C.line}; border-radius:11px; box-shadow:0 4px 16px var(--cc-shadow);`)}>
        <div style={css(`font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase; color:${C.faint};`)}>The cascade — higher lanes win</div>
        <div style={css('display:flex; align-items:center; gap:8px;')}>
          <svg width="30" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="var(--cc-edge-conflict)" strokeWidth="1.8" strokeDasharray="5 5" /></svg>
          <span style={css(`font-size:11.5px; color:${C.caption};`)}>a lower layer disagrees — click to resolve</span>
        </div>
      </div>

      {/* zoom controls */}
      <div style={css(`position:absolute; right:20px; bottom:20px; display:flex; flex-direction:column; gap:6px;`)}>
        {[['+', () => zoom(1)], ['−', () => zoom(-1)], ['⤢', fit]].map(([label, fn]) => (
          <button
            key={label as string}
            className="cc-h-navbg"
            onClick={fn as () => void}
            title={label === '⤢' ? 'Fit' : label === '+' ? 'Zoom in' : 'Zoom out'}
            style={css(`display:grid; place-items:center; width:36px; height:36px; background:${C.surface}; border:1px solid ${C.lineStrong}; border-radius:9px; cursor:pointer; color:${C.body}; font-size:16px; font-weight:500;`)}
          >{label as string}</button>
        ))}
      </div>

      {/* node detail slide-over */}
      {openConceptObj && (
        <div>
          <div onClick={() => setOpenId(null)} style={css('position:absolute; inset:0; background:var(--cc-scrim); animation:ccFade 0.2s ease;')} />
          <aside role="dialog" aria-modal="true" aria-label={`${openConceptObj.title} — concept detail`} style={css(`position:absolute; top:0; right:0; height:100%; width:436px; display:flex; flex-direction:column; background:${C.surface}; border-left:1px solid ${C.lineStrong}; box-shadow:-24px 0 60px var(--cc-shadow); animation:ccSlide 0.26s cubic-bezier(0.16,1,0.3,1);`)}>
            <div style={css(`display:flex; align-items:center; justify-content:flex-end; padding:12px 14px 0;`)}>
              <button className="cc-h-eae" onClick={() => setOpenId(null)} aria-label="Close concept detail" style={css(`display:grid; place-items:center; width:30px; height:30px; border:none; background:transparent; border-radius:7px; cursor:pointer; color:${C.caption};`)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div style={css('flex:1; overflow-y:auto; padding:6px 22px 22px;')}>
              <ConceptDetail concept={openConceptObj} />
              {openHasConflict && (
                <button className="cc-h-bd-amber2" onClick={() => openConflictFor(openConceptObj.id)} style={css('display:flex; align-items:center; gap:9px; width:100%; margin-top:18px; padding:12px 14px; background:#FBF0DD; border:1px solid #D69A3F; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                  <span style={css('flex:1; font-size:12.5px; color:#5A3D12; line-height:1.35;')}><strong style={css('font-weight:600;')}>Layers disagree here.</strong> Open the resolver.</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
