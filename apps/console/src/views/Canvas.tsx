import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { C, css, lc, MONO, type LayerId } from '../theme'
import { layerLevel, layerName, layers, type Concept, type Conflict } from '../data'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { ConflictQuickResolve } from '../components/ConflictQuickResolve'
import { useStoreData } from '../store'

// Statuses a conflict can still be acted on from — matches Overview.tsx's
// "Needs Attention" actionable filter. A resolved/acknowledged conflict keeps
// its badge read-only rather than offering dispositions that no longer apply.
const ACTIONABLE_DISCREPANCY_STATUSES = new Set(['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'])

// ---- layout constants (world coordinates) ----
const NODE_W = 214, NODE_H = 96
const GHOST_W = 196, GHOST_H = 66
const GAP_X = 28, START_X = 138, END_X = 24
const LANE_TOP = 60, LANE_GAP = 16
// A lane no longer lays its nodes out in one ever-widening row — that made a
// saturated lane's Fit shrink cards toward MIN_SCALE just to keep the whole
// row on screen (see MAX_NODES_PER_LANE's derivation for the exact numbers
// this replaced). Nodes wrap into a grid instead: a fixed number of columns,
// as many rows as a lane needs, trading horizontal sprawl for lane height.
const COLS_PER_ROW = 6
const ROW_GAP_Y = 20
// Vertical padding inside a lane box, and the gap between a lane's primary
// row(s) and its ghost (dissent) row(s) when it has both.
const LANE_PAD_TOP = 46, LANE_PAD_BOTTOM = 24, GHOST_BAND_GAP = 24

// A real-DOM canvas with no virtualization: every node is a live element in
// the pan/zoom transform, so a vault with thousands of concepts in one lane
// stops being interactive well before it stops being legible. Cap what's
// rendered rather than let the browser choke on it — Knowledge (unpaginated,
// list-based) is where the rest is still reachable.
//
// Grid-wrapping (above) moves the binding dimension from worldW to worldH: a
// worst case of every concept landing in ONE lane (same reasoning as before —
// nodes sharing a primary lane always conflict, so N nodes in a single lane
// still cost N columns, just wrapped into ceil(N / COLS_PER_ROW) rows instead
// of N side-by-side) makes worldH, not worldW, grow with N:
//   pRows(N) = ceil(N / COLS_PER_ROW)
//   worldH(N) = LANE_TOP + [LANE_PAD_TOP + pRows*NODE_H + (pRows-1)*ROW_GAP_Y + LANE_PAD_BOTTOM]
//               + 2 * (LANE_GAP + LANE_PAD_TOP + LANE_PAD_BOTTOM)   // the other two lanes, empty
// worldW is now bounded regardless of N (at most COLS_PER_ROW columns), so it
// is never the constraint MIN_SCALE has to protect against.
//
// This cap is deliberately NOT raised to the point where Fit would need
// MIN_SCALE — it's a render-cost ceiling now (this is still a real-DOM canvas
// with no virtualization), not a legibility floor. 60 (2.5x the old cap of
// 24) keeps the DOM node increase modest while landing Fit at ~0.52 on a
// 1280px-wide viewport even at its fully-saturated worst case (pRows=10,
// worldH=1442, scale = 752/1442) — more than double the old cap's ~0.21,
// comfortably clear of the floor with headroom to spare.
export const MAX_NODES_PER_LANE = 60
// The ONE floor shared by Fit and manual zoom (wheel / +/- controls). These
// used to differ (Fit ~0, manual 0.1): a 3,000-concept vault's Fit landed at
// scale 0.023 — cards rendered sub-pixel, the screenshot was a blank canvas
// with one faint dashed line — and the first wheel notch in EITHER direction
// then clamped up to the manual floor, magnifying the view 4x under the
// cursor. Splitting the floors again would only resurrect that: the fix is
// one shared number, low enough to still be a legible discrete card and no
// lower.
//
// Derivation: a card narrower than ~40 screen px reads as a sliver, not a
// rectangle — NODE_W (214px) needs to render at >= ~40px for the card to be a
// visible, color-coded shape (border + lane accent) rather than noise:
//   40 / 214 ≈ 0.187, rounded up to 0.2 for a clean shared constant.
// With grid-wrapping, MAX_NODES_PER_LANE's fully-saturated worst case lands
// Fit at ~0.52 (see its derivation) — comfortably above 0.2, so in practice
// Fit never needs the floor at all; it exists purely as the shared backstop
// both Fit and manual zoom respect (and as the floor a shrunk browser window
// can still legitimately hit — see computeFitScale's "crops rather than
// shrinking" test), so neither can ever clamp past the other.
export const MIN_SCALE = 0.2
const MAX_SCALE = 2

const NUM = new Intl.NumberFormat()

// lanes top→bottom: highest precedence (Personal) on top so "up = wins"
const LANE_ORDER: LayerId[] = ['personal', 'team', 'company']
const primaryLayer = (c: Concept): LayerId =>
  c.layers.slice().sort((a, b) => layerLevel(b) - layerLevel(a))[0]

/** Fit scale/pan for a `cw`×`ch` viewport around `worldW`×`worldH` content, or
 *  `null` while the element is not yet laid out (see the caller's guard). */
export function computeFitScale(cw: number, ch: number, worldW: number, worldH: number) {
  if (cw < 40 || ch < 40) return null
  const scale = Math.max(MIN_SCALE, Math.min(1, (cw - 48) / worldW, (ch - 48) / worldH))
  return { scale, tx: (cw - worldW * scale) / 2, ty: Math.max(24, (ch - worldH * scale) / 2) }
}

/** Clamp a manual zoom (wheel or +/− button) to the app's zoom range. */
export function clampZoom(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export interface LaneCapResult {
  concepts: Concept[]
  shown: number
  total: number
  laneCounts: Record<LayerId, { shown: number; total: number }>
}

/**
 * Cap how many concepts land on the canvas per lane. Selection keeps the
 * first N in resolve-all order: `Concept` carries no single "last updated"
 * timestamp of its own (only per-section dates), and scanning every section
 * of every concept just to sort would undercut the point of a cheap cap at
 * the scale this exists for.
 */
export function capConceptsPerLane(concepts: Concept[], max = MAX_NODES_PER_LANE): LaneCapResult {
  const byLane: Record<LayerId, Concept[]> = { company: [], team: [], personal: [] }
  // primaryLayer(c) is undefined for a concept with an empty `layers` array
  // (sort()[0] of []) despite its declared LayerId return type — a chaos
  // input computeLayout also tolerates (its own `primaryLayer(c) ?? 'company'`
  // falls back the same way). Here it indexed straight into `byLane` and
  // called .push on the resulting undefined, unmounting the whole view.
  // Falling back to the company lane matches that existing tolerance.
  for (const c of concepts) (byLane[primaryLayer(c)] ?? byLane.company).push(c)
  const laneCounts = {} as Record<LayerId, { shown: number; total: number }>
  const out: Concept[] = []
  for (const id of LANE_ORDER) {
    const all = byLane[id]
    const shown = all.slice(0, max)
    laneCounts[id] = { shown: shown.length, total: all.length }
    out.push(...shown)
  }
  return { concepts: out, shown: out.length, total: concepts.length, laneCounts }
}

/**
 * Full per-lane concept counts — honest even while the canvas only renders
 * the capped subset (capConceptsPerLane). Shares capConceptsPerLane's
 * company fallback for a concept with an empty `layers` array (primaryLayer
 * returns undefined there): without it, such a concept indexed a stray
 * "undefined" key here — consuming a company slot in the capped render
 * while never appearing in company's header total.
 */
export function countByLane(concepts: Concept[]): Record<LayerId, number> {
  const counts: Record<LayerId, number> = { company: 0, team: 0, personal: 0 }
  for (const c of concepts) counts[primaryLayer(c) ?? 'company'] += 1
  return counts
}

interface NodePos { c: Concept; x: number; y: number; conflict: boolean }
interface GhostPos { key: string; parent: NodePos; layer: LayerId; value: string; sectionKey: string; x: number; y: number }

export interface LaneGeometry { top: number; height: number }

export function computeLayout(concepts: Concept[]) {
  // A concept occupies its winning lane plus every lane where it has a
  // dissent card. Reuse a column whenever those occupied lanes do not overlap;
  // this keeps sparse cascades compact without allowing cards to collide. The
  // column index is global (shared across lanes) — unchanged from before
  // grid-wrapping — it's what a lane's rows are wrapped from below.
  const columnLayers: Array<Set<LayerId>> = []
  const assigned = concepts.map((c) => {
    const occupied = new Set<LayerId>([primaryLayer(c)])
    for (const section of c.sections) {
      for (const dissent of section.dissents ?? []) occupied.add(dissent.layer)
    }
    let column = columnLayers.findIndex((layersInColumn) =>
      Array.from(occupied).every((layer) => !layersInColumn.has(layer)))
    if (column === -1) {
      column = columnLayers.length
      columnLayers.push(new Set())
    }
    for (const layer of occupied) columnLayers[column].add(layer)
    return { c, column }
  })
  const rowOf = (column: number) => Math.floor(column / COLS_PER_ROW)
  const colOf = (column: number) => column % COLS_PER_ROW

  // How many primary-node rows and ghost (dissent) rows each lane needs, from
  // the column assignments above — a ghost keeps its parent's global column
  // (so it stays x-aligned under the parent regardless of row), stacked in
  // its own band below the lane's primary rows. Two concepts' occupied-lane
  // sets always overlap when one dissents into the other's lane or a shared
  // primary lane, so the column reservation above already guarantees a
  // ghost's (lane, column) can never coincide with a primary node's there —
  // stacking ghost rows after primary rows cannot introduce a new collision.
  const primaryRows: Record<LayerId, number> = { personal: 0, team: 0, company: 0 }
  const ghostRows: Record<LayerId, number> = { personal: 0, team: 0, company: 0 }
  for (const { c, column } of assigned) {
    // primaryLayer(c) is undefined for a concept with an empty `layers` array
    // (sort()[0] of []) — falls back to company, matching capConceptsPerLane
    // and countByLane's existing tolerance for the same chaos input.
    const lane = primaryLayer(c) ?? 'company'
    primaryRows[lane] = Math.max(primaryRows[lane], rowOf(column) + 1)
    const seen = new Set<LayerId>()
    for (const s of c.sections) {
      for (const d of s.dissents ?? []) {
        if (seen.has(d.layer)) continue
        seen.add(d.layer)
        ghostRows[d.layer] = Math.max(ghostRows[d.layer], rowOf(column) + 1)
      }
    }
  }

  // Stack lanes top→bottom, each sized to its own row counts rather than a
  // fixed height — an empty or sparse lane no longer inherits a saturated
  // one's height, and a saturated lane grows down instead of pushing worldW out.
  const laneTop: Record<LayerId, number> = { personal: 0, team: 0, company: 0 }
  const laneHeight: Record<LayerId, number> = { personal: 0, team: 0, company: 0 }
  const primaryBandH: Record<LayerId, number> = { personal: 0, team: 0, company: 0 }
  let cursor = LANE_TOP
  for (const id of LANE_ORDER) {
    const pRows = primaryRows[id], gRows = ghostRows[id]
    const pBand = pRows > 0 ? pRows * NODE_H + (pRows - 1) * ROW_GAP_Y : 0
    const gBand = gRows > 0 ? gRows * GHOST_H + (gRows - 1) * ROW_GAP_Y : 0
    primaryBandH[id] = pBand
    laneTop[id] = cursor
    laneHeight[id] = LANE_PAD_TOP + pBand + (gRows > 0 ? GHOST_BAND_GAP + gBand : 0) + LANE_PAD_BOTTOM
    cursor += laneHeight[id] + LANE_GAP
  }
  const worldH = cursor - LANE_GAP

  const nodes: NodePos[] = assigned.map(({ c, column }) => {
    const lane = primaryLayer(c) ?? 'company'
    const x = START_X + colOf(column) * (NODE_W + GAP_X)
    const y = laneTop[lane] + LANE_PAD_TOP + rowOf(column) * (NODE_H + ROW_GAP_Y)
    return { c, x, y, conflict: c.sections.some((s) => (s.dissents?.length ?? 0) > 0) }
  })

  const ghosts: GhostPos[] = []
  assigned.forEach(({ c, column }, i) => {
    const seen = new Set<LayerId>()
    for (const s of c.sections) {
      for (const d of s.dissents ?? []) {
        if (seen.has(d.layer)) continue
        seen.add(d.layer)
        ghosts.push({
          key: `${c.id}:${d.layer}`, parent: nodes[i], layer: d.layer, value: d.value,
          sectionKey: s.key ?? s.name,
          x: START_X + colOf(column) * (NODE_W + GAP_X) + (NODE_W - GHOST_W) / 2,
          y: laneTop[d.layer] + LANE_PAD_TOP + primaryBandH[d.layer] + GHOST_BAND_GAP + rowOf(column) * (GHOST_H + ROW_GAP_Y),
        })
      }
    }
  })

  // worldW is bounded at COLS_PER_ROW columns regardless of N (fewer when the
  // cascade is sparse, so a small cascade carries no dead whitespace).
  const colsUsed = Math.min(Math.max(1, columnLayers.length), COLS_PER_ROW)
  const worldW = START_X + colsUsed * NODE_W + Math.max(0, colsUsed - 1) * GAP_X + END_X
  const lanes: Record<LayerId, LaneGeometry> = {
    personal: { top: laneTop.personal, height: laneHeight.personal },
    team: { top: laneTop.team, height: laneHeight.team },
    company: { top: laneTop.company, height: laneHeight.company },
  }
  return { nodes, ghosts, worldW, worldH, lanes }
}

/** Cubic bezier between two vertically-separated anchor points. */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dy = Math.max(40, (y2 - y1) * 0.5)
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
}

function CanvasInner({ keyboardSuspended = false }: { keyboardSuspended?: boolean }) {
  const { setSelConcept, setSelConflict, setView, conflicts, concepts, sources, mode } = useStoreData()
  // Capped before layout: a real-DOM canvas with no virtualization stops
  // being usable well before thousands of nodes finish laying out. Ghost
  // (dissent) cards derive from `nodes` below, so they respect the cap too —
  // there is no separate ghost list to cap.
  const capped = useMemo(() => capConceptsPerLane(concepts), [concepts])
  // Memoized: pan/zoom re-renders every pointermove — don't re-lay-out for those.
  const { nodes, ghosts, worldW, worldH, lanes } = useMemo(() => computeLayout(capped.concepts), [capped.concepts])
  // Full counts, not the capped subset — the lane header's "N concepts" stays
  // an honest total even while the canvas itself only renders some of them.
  const laneCounts = useMemo(() => countByLane(concepts), [concepts])
  const conflictsByConcept = useMemo(() => {
    const grouped = new Map<string, Conflict[]>()
    for (const conflict of conflicts) grouped.set(conflict.concept, [...(grouped.get(conflict.concept) ?? []), conflict])
    return grouped
  }, [conflicts])
  // Real (source name, level) pairs behind each lane, for honest lane headers
  // (Fix F3): demo mode's sources are already the canonical company/team/
  // personal trio, so this reduces to the static labels there — the fallback
  // below only changes what a live, non-canonical cascade renders.
  const laneSourceRows = useMemo(() => {
    const rows: Record<LayerId, { name: string; level: number }[]> = { company: [], team: [], personal: [] }
    if (mode === 'demo') return rows
    for (const s of sources) rows[s.layer].push({ name: s.name, level: s.level })
    return rows
  }, [sources, mode])

  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setViewT] = useState({ tx: 40, ty: 20, scale: 1 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [quickResolve, setQuickResolve] = useState<{ conflict: Conflict; anchorEl: HTMLElement } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [wideInspector, setWideInspector] = useState(false)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const inspectorOpener = useRef<HTMLButtonElement | null>(null)
  const inspectorRef = useRef<HTMLElement | null>(null)

  const fit = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    // computeFitScale's own guard covers a not-yet-laid-out element (async
    // data can populate before layout settles): a zero width would otherwise
    // yield a negative scale that never self-corrects, collapsing the canvas
    // to a speck.
    const next = computeFitScale(el.clientWidth, el.clientHeight, worldW, worldH)
    if (next) setViewT(next)
  }, [worldW, worldH])

  useLayoutEffect(() => { fit() }, [fit])

  // Refit once the canvas actually has a measured size and on any resize — the
  // useLayoutEffect above can fire before the element is laid out.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { setWideInspector(el.clientWidth >= 840); fit() })
    ro.observe(el)
    setWideInspector(el.clientWidth >= 840)
    return () => ro.disconnect()
  }, [fit])

  // native wheel listener so we can preventDefault (zoom toward cursor)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left, py = e.clientY - rect.top
      setViewT((v) => {
        const next = clampZoom(v.scale * Math.exp(-e.deltaY * 0.0015))
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

  const openConcept = (c: Concept, opener: HTMLButtonElement) => { inspectorOpener.current = opener; setOpenId(c.id); setSelConcept(c.id) }
  const closeInspector = () => {
    setOpenId(null)
    requestAnimationFrame(() => inspectorOpener.current?.focus())
  }
  const openConflictFor = (conceptId: string, anchorEl: HTMLElement, sectionKey?: string) => {
    const candidates = conflictsByConcept.get(conceptId) ?? []
    const cf = sectionKey
      ? candidates.find((conflict) => conflict.sectionKey === sectionKey)
      : candidates.length === 1 ? candidates[0] : null
    // A concept-level badge can represent several different discrepancies.
    // Never make a one-click decision on an arbitrary first match: hand the
    // ambiguous case to Review, where every candidate is visible.
    if (!cf) {
      if (candidates[0]) {
        setSelConflict(candidates[0].id)
        setView('conflicts')
      }
      return
    }
    const status = cf.discrepancyStatus ?? (cf.status === 'open' ? 'needs_review' : 'resolved')
    if (ACTIONABLE_DISCREPANCY_STATUSES.has(status)) {
      setQuickResolve({ conflict: cf, anchorEl })
    } else {
      setSelConflict(cf.id); setView('conflicts')
    }
  }

  // Escape closes the node slide-over.
  useEffect(() => {
    if (!openId || keyboardSuspended) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeInspector() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboardSuspended, openId])
  useEffect(() => {
    if (!openId || wideInspector || keyboardSuspended) return
    const panel = inspectorRef.current
    const items = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') ?? [])
    items()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = items()
      if (!focusable.length) return
      const position = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (position - 1 + focusable.length) % focusable.length : (position + 1) % focusable.length
      event.preventDefault()
      focusable[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboardSuspended, openId, wideInspector])
  const zoom = (dir: number) => setViewT((v) => {
    const el = wrapRef.current!, px = el.clientWidth / 2, py = el.clientHeight / 2
    const next = clampZoom(v.scale * (dir > 0 ? 1.2 : 1 / 1.2))
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
        style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: wideInspector && openConceptObj ? 360 : 0, cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, width: worldW, height: worldH }}>
          {/* lane backgrounds + labels — real levels and source names behind
              each lane, not the static trio (F3): a level-1 source that ranks
              into 'team' should say so, and two sources sharing a lane should
              both be named rather than only the lane's generic blurb. */}
          {LANE_ORDER.map((id) => {
            const L = layers.find((l) => l.id === id)!
            const col = lc(id)
            const rows = laneSourceRows[id]
            const levels = [...new Set(rows.map((r) => r.level))].sort((a, b) => a - b)
            const conventional = rows.some((r) => r.name === id)
            const badgeText = levels.length ? levels.join('/') : String(L.level)
            const primary = conventional || rows.length === 0 ? L.name : `L${levels.join('/')}`
            const detail = rows.length ? rows.map((r) => r.name).join(', ') : L.members
            return (
              <div key={id} style={{ position: 'absolute', left: 0, top: lanes[id].top, width: worldW, height: lanes[id].height }}>
                <div style={css(`position:absolute; inset:0; background:var(--cc-lane-bg); border:1px solid var(--cc-lane-line); border-radius:16px;`)} />
                <div style={css(`position:absolute; left:18px; top:14px; display:flex; align-items:center; gap:10px;`)}>
                  <span style={css(`display:grid; place-items:center; width:26px; height:26px; border-radius:999px; background:${col.fill}; color:${col.text}; font-family:${MONO}; font-weight:600; font-size:12px;`)}>{badgeText}</span>
                  <div style={{ lineHeight: 1.15 }}>
                    <div style={css(`font-size:13px; font-weight:600; color:${col.text};`)}>{primary}</div>
                    <div style={css(`font-size:10.5px; color:${C.caption}; font-family:${MONO};`)}>{detail} · {laneCounts[id]} concept{laneCounts[id] === 1 ? '' : 's'}</div>
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
                onClick={(event) => openConflictFor(g.parent.c.id, event.currentTarget, g.sectionKey)}
                onMouseEnter={() => setHoverId(g.parent.c.id)}
                onMouseLeave={() => setHoverId(null)}
                title="Layers disagree — open the conflict"
                aria-label={`${g.parent.c.title} — ${layerName(g.layer)} dissents, has conflict`}
                style={{ position: 'absolute', left: g.x, top: g.y, width: GHOST_W, height: GHOST_H, ...css(`display:flex; flex-direction:column; justify-content:center; gap:4px; text-align:left; padding:10px 12px; background:${C.surface}; border:1px dashed var(--cc-edge-conflict); border-radius:11px; cursor:pointer; font:inherit;`) }}
              >
                <div style={css('display:flex; align-items:center; gap:7px;')}>
                  <LayerChip id={g.layer} />
                  <span style={css(`font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:${C.amberText};`)}>overridden</span>
                </div>
                <div style={css(`font-size:11.5px; color:${col.text2}; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`)}>{g.value}</div>
              </button>
            )
          })}

          {/* concept nodes */}
          {nodes.map((n) => {
            const col = lc(primaryLayer(n.c))
            const selected = openId === n.c.id
            const hasConflict = n.conflict || conflictsByConcept.has(n.c.id)
            const glow = selected ? `0 0 0 2px ${col.strokeE}, 0 10px 30px var(--cc-node-glow)` : `0 2px 10px var(--cc-shadow)`
            return (
              <button
                key={n.c.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(event) => {
                  // The conflict badge is a click hit-region within this single
                  // button, not a nested interactive element (a <button> cannot
                  // validly contain another one) — a mouse click there opens the
                  // quick-resolve popover directly; everyone else (including
                  // keyboard/screen-reader users) still reaches resolution
                  // through the concept detail's "Layers disagree here" button,
                  // so this is a mouse-only shortcut, not the only path.
                  const badge = (event.target as HTMLElement).closest<HTMLElement>('[data-role="conflict-badge"]')
                  if (badge && hasConflict) { openConflictFor(n.c.id, badge); return }
                  openConcept(n.c, event.currentTarget)
                }}
                onMouseEnter={() => setHoverId(n.c.id)}
                onMouseLeave={() => setHoverId(null)}
                aria-label={`${n.c.title} — ${layerName(primaryLayer(n.c))}${hasConflict ? ', has conflict' : n.c.draft ? ', draft' : ''}`}
                style={{ position: 'absolute', left: n.x, top: n.y, width: NODE_W, height: NODE_H, boxShadow: glow, ...css(`display:flex; flex-direction:column; gap:0; text-align:left; padding:12px 14px; background:${C.raised}; border:1px solid ${selected ? col.strokeE : C.line}; border-left:3px solid ${col.strokeE}; border-radius:12px; cursor:pointer; font:inherit;`) }}
              >
                <div style={css('display:flex; align-items:center; gap:8px;')}>
                  <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 7px; border-radius:6px; color:${col.text}; background:${col.fill};`)}>{n.c.type}</span>
                  {hasConflict && (
                    <span data-role="conflict-badge" title="Layers disagree — click to resolve" style={css(`display:inline-flex; align-items:center; gap:4px; margin-left:auto; font-size:9.5px; font-weight:600; color:${C.amberText}; cursor:pointer;`)}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>conflict
                    </span>
                  )}
                  {n.c.draft && !hasConflict && <span style={css(`margin-left:auto; font-size:10px; font-family:${MONO}; color:${C.amberText2};`)}>draft</span>}
                </div>
                <div style={css(`font-weight:600; font-size:13.5px; margin-top:9px; color:${C.ink}; line-height:1.25;`)}>{n.c.title}</div>
                <code style={css(`font-family:${MONO}; font-size:10.5px; color:${C.caption}; margin-top:auto;`)}>{n.c.id}</code>
              </button>
            )
          })}
        </div>
      </div>

      {/*
        legend — the one blurred surface in the app with moving content behind
        it. It floats over the pan/zoom viewport, so concept nodes and their
        conflict edges slide underneath as the user drags; going opaque here
        turned a card the graph reads through into a hole punched in it. That is
        the opposite of the chrome panels, which sit in normal flow over a static
        page gradient. Users who want it gone have the reduce-transparency
        preference, which resolves --cc-header-bg to the opaque raised surface
        and kills backdrop-filter app-wide (see styles.css).
      */}
      <div style={css(`position:absolute; left:20px; bottom:20px; display:flex; flex-direction:column; gap:8px; padding:12px 14px; background:var(--cc-header-bg); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid ${C.line}; border-radius:11px; box-shadow:0 4px 16px var(--cc-shadow);`)}>
        <div style={css(`font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase; color:${C.caption};`)}>The cascade — higher lanes win</div>
        <div style={css('display:flex; align-items:center; gap:8px;')}>
          <svg width="30" height="10"><line x1="0" y1="5" x2="30" y2="5" stroke="var(--cc-edge-conflict)" strokeWidth="1.8" strokeDasharray="5 5" /></svg>
          <span style={css(`font-size:11.5px; color:${C.caption};`)}>a lower layer disagrees — click to resolve</span>
        </div>
      </div>

      {/* zoom controls */}
      <div style={css(`position:absolute; right:20px; bottom:20px; display:flex; flex-direction:column; gap:6px;`)}>
        {([['+', 'Zoom in', () => zoom(1)], ['−', 'Zoom out', () => zoom(-1)], ['⤢', 'Fit to view', fit]] as const).map(([label, name, fn]) => (
          <button
            key={name}
            className="cc-h-navbg"
            onClick={fn}
            title={name}
            aria-label={name}
            style={css(`display:grid; place-items:center; width:36px; height:36px; background:${C.surface}; border:1px solid ${C.lineStrong}; border-radius:9px; cursor:pointer; color:${C.body}; font-size:16px; font-weight:500;`)}
          >{label}</button>
        ))}
      </div>

      {/* cap banner — a real-DOM canvas with no virtualization stops being
          usable well before a large cascade finishes laying out (F7); this
          says what's hidden and where the rest still is. */}
      {capped.shown < capped.total && (
        <div style={css(`position:absolute; left:20px; top:16px; display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--cc-header-bg); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid ${C.line}; border-radius:9px; box-shadow:0 4px 16px var(--cc-shadow);`)}>
          <span style={css(`font-size:11.5px; color:${C.caption};`)}>Showing {NUM.format(capped.shown)} of {NUM.format(capped.total)}</span>
          <button
            type="button"
            className="cc-h-bd-strong"
            onClick={() => setView('concepts')}
            style={css(`padding:2px 9px; border:1px solid ${C.lineStrong}; border-radius:999px; background:${C.raised}; cursor:pointer; font:inherit; font-size:11px; font-weight:600; color:${C.body};`)}
          >Browse everything in Knowledge</button>
        </div>
      )}

      {/* node detail slide-over */}
      {openConceptObj && (
        <div>
          {!wideInspector && <div onClick={closeInspector} style={css('position:absolute; inset:0; background:var(--cc-scrim); animation:ccFade 0.2s ease;')} />}
          <aside ref={inspectorRef} role={wideInspector ? 'complementary' : 'dialog'} aria-modal={wideInspector ? undefined : 'true'} aria-label={`${openConceptObj.title} — concept detail`} style={css(`position:absolute; top:0; right:0; height:100%; width:${wideInspector ? 360 : 420}px; max-width:100%; display:flex; flex-direction:column; background:${C.surface}; border-left:1px solid ${C.lineStrong}; box-shadow:${wideInspector ? 'none' : '-24px 0 60px var(--cc-shadow)'}; animation:ccSlide 0.18s var(--cc-ease-out);`)}>
            <div style={css(`display:flex; align-items:center; justify-content:flex-end; padding:12px 14px 0;`)}>
              <button className="cc-h-eae" onClick={closeInspector} aria-label="Close concept detail" style={css(`display:grid; place-items:center; width:30px; height:30px; border:none; background:transparent; border-radius:7px; cursor:pointer; color:${C.caption};`)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div style={css('flex:1; overflow-y:auto; padding:6px 22px 22px;')}>
              <ConceptDetail concept={openConceptObj} />
              {openHasConflict && (
                <button className="cc-h-bd-amber2" onClick={(event) => openConflictFor(openConceptObj.id, event.currentTarget)} style={css('display:flex; align-items:center; gap:9px; width:100%; margin-top:18px; padding:12px 14px; background:#FBF0DD; border:1px solid #D69A3F; border-radius:10px; cursor:pointer; font:inherit; text-align:left;')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                  <span style={css('flex:1; font-size:12.5px; color:#5A3D12; line-height:1.35;')}><strong style={css('font-weight:600;')}>Layers disagree here.</strong> Open the resolver.</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {quickResolve && (
        <ConflictQuickResolve
          key={quickResolve.conflict.id}
          conflict={quickResolve.conflict}
          anchorEl={quickResolve.anchorEl}
          onClose={() => setQuickResolve(null)}
          onOpenFullResolver={() => {
            setSelConflict(quickResolve.conflict.id)
            setView('conflicts')
            setQuickResolve(null)
          }}
        />
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
export const Canvas = memo(CanvasInner)
