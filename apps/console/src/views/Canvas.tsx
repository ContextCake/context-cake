import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { C, css, lc, MONO, type LayerId } from '../theme'
import { layerLevel, layerName, layers, type Concept, type Conflict } from '../data'
import { LayerChip } from '../components/LayerChip'
import { ConceptDetail } from '../components/ConceptDetail'
import { ConflictQuickResolve } from '../components/ConflictQuickResolve'
import { useStoreData } from '../store'
import { CASCADE_HIDDEN_NODES_KEY, onCascadeDisplayModeChange, onCascadeHiddenNodesChange, readCascadeDisplayMode, type CascadeDisplayMode } from '../cascade-preferences'

// Statuses a conflict can still be acted on from — matches Overview.tsx's
// "Needs Attention" actionable filter. A resolved/acknowledged conflict keeps
// its badge read-only rather than offering dispositions that no longer apply.
const ACTIONABLE_DISCREPANCY_STATUSES = new Set(['needs_review', 'reopened', 'recommended', 'auto_ready', 'blocked'])

interface CanvasMetrics {
  nodeW: number; nodeH: number; ghostW: number; ghostH: number
  gapX: number; rowGapY: number; colsPerRow: number
}

const CARD_METRICS: CanvasMetrics = {
  nodeW: 190, nodeH: 82, ghostW: 174, ghostH: 58,
  gapX: 18, rowGapY: 14, colsPerRow: 7,
}
const COMPACT_METRICS: CanvasMetrics = {
  nodeW: 172, nodeH: 48, ghostW: 158, ghostH: 40,
  gapX: 10, rowGapY: 9, colsPerRow: 8,
}
const GROUPED_METRICS: CanvasMetrics = {
  nodeW: 188, nodeH: 52, ghostW: 172, ghostH: 42,
  gapX: 12, rowGapY: 10, colsPerRow: 6,
}
const METRICS_BY_MODE: Record<CascadeDisplayMode, CanvasMetrics> = {
  grouped: GROUPED_METRICS,
  compact: COMPACT_METRICS,
  cards: CARD_METRICS,
}

const START_X = 138, END_X = 24
const LANE_TOP = 60, LANE_GAP = 16
// A lane no longer lays its nodes out in one ever-widening row — that made a
// saturated lane's Fit shrink cards toward MIN_SCALE just to keep the whole
// row on screen (see MAX_NODES_PER_LANE's derivation for the exact numbers
// this replaced). Nodes wrap into a grid instead: a fixed number of columns,
// as many rows as a lane needs, trading horizontal sprawl for lane height.
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
// 24) keeps the DOM increase modest and produces at most ten grouped rows;
// the denser flat modes fit the same content in fewer rows.
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
// Derivation: a card narrower than ~34 screen px reads as a sliver, not a
// rectangle — the smallest NODE_W (172px) needs to render at >= ~34px for the
// card to remain a visible, color-coded shape (border + lane accent):
//   34 / 172 ≈ 0.198, rounded to 0.2 for a clean shared constant.
// With grid-wrapping, the current cap still fits above that floor on a normal
// desktop viewport. The floor exists as the shared backstop
// both Fit and manual zoom respect (and as the floor a shrunk browser window
// can still legitimately hit — see computeFitScale's "crops rather than
// shrinking" test), so neither can ever clamp past the other.
export const MIN_SCALE = 0.2
const MAX_SCALE = 2

const NUM = new Intl.NumberFormat()
export const GROUP_MIN_SIZE = 4
export const FOLDER_PAGE_SIZE = 100
const MAX_HIDDEN_TARGETS = 1_000
const MAX_HIDDEN_KEY_LENGTH = 2_048
const MAX_HIDDEN_TOTAL_CHARS = 250_000

// lanes top→bottom: highest precedence (Personal) on top so "up = wins"
const LANE_ORDER: LayerId[] = ['personal', 'team', 'company']
const primaryLayer = (c: Concept): LayerId =>
  c.layers.slice().sort((a, b) => layerLevel(b) - layerLevel(a))[0]

export interface CanvasConceptGroup {
  id: string
  folder: string
  layer: LayerId
  concepts: Concept[]
  conflictCount: number
  draftCount: number
}

export interface CanvasPresentation {
  concepts: Concept[]
  groups: Map<string, CanvasConceptGroup>
}

function conceptHasConflict(concept: Concept): boolean {
  return concept.conflict === true || concept.sections.some((section) => (section.dissents?.length ?? 0) > 0)
}

function conceptFolder(concept: Concept): string | null {
  const slash = concept.id.indexOf('/')
  return slash > 0 ? concept.id.slice(0, slash) : null
}

export function conceptSupportingText(concept: Pick<Concept, 'id' | 'title'>): string | null {
  const normalize = (value: string) => value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return normalize(concept.title) === normalize(concept.id) ? null : concept.id
}

export function filterFolderConcepts(concepts: Concept[], query: string): Concept[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return concepts
  return concepts.filter((concept) =>
    concept.title.toLocaleLowerCase().includes(normalized)
    || concept.id.toLocaleLowerCase().includes(normalized)
    || concept.type.toLocaleLowerCase().includes(normalized))
}

function groupBucketKey(layer: LayerId, folder: string): string {
  // JSON's string escaping makes this injective even for arbitrary MCP node
  // ids containing separators or control characters.
  return JSON.stringify([layer, folder])
}

function groupId(layer: LayerId, folder: string, occupiedIds: Set<string>): string {
  const base = `__contextcake_group__/${layer}/${JSON.stringify(folder)}`
  let candidate = base
  let suffix = 1
  while (occupiedIds.has(candidate)) candidate = `${base}#${suffix++}`
  occupiedIds.add(candidate)
  return candidate
}

export function hiddenKeyForConcept(id: string): string {
  return `concept:${id}`
}

export function hiddenKeyForFolder(layer: LayerId, folder: string): string {
  // JSON string encoding is total over arbitrary MCP ids, including control
  // characters and lone surrogates that make encodeURIComponent throw.
  return `folder:${layer}:${JSON.stringify(folder)}`
}

interface HiddenFolderTarget {
  layer: LayerId
  folder: string
}

function parseHiddenFolderKey(key: string): HiddenFolderTarget | null {
  const match = /^folder:(personal|team|company):([\s\S]+)$/.exec(key)
  if (!match) return null
  try {
    // JSON is the current total encoding. Percent-decoding keeps preferences
    // written by earlier preview builds readable.
    const folder = match[2].startsWith('"') ? JSON.parse(match[2]) : decodeURIComponent(match[2])
    if (typeof folder !== 'string') return null
    if (!folder) return null
    return { layer: match[1] as LayerId, folder }
  } catch {
    return null
  }
}

function isStoredHiddenTarget(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_HIDDEN_KEY_LENGTH) return false
  if (value.startsWith('concept:')) return value.length > 'concept:'.length
  return parseHiddenFolderKey(value) !== null
}

export function isConceptHidden(concept: Concept, hiddenTargets: ReadonlySet<string>): boolean {
  if (hiddenTargets.has(hiddenKeyForConcept(concept.id))) return true
  const folder = conceptFolder(concept)
  const layer = primaryLayer(concept) ?? 'company'
  return folder ? hiddenTargets.has(hiddenKeyForFolder(layer, folder)) : false
}

/**
 * Collapse large top-level folders into one honest summary node. Groups never
 * cross precedence lanes, and small folders stay as ordinary concepts so a
 * compact cascade does not turn into a wall of one-item folders.
 */
export function buildCanvasPresentation(
  concepts: Concept[],
  displayMode: CascadeDisplayMode,
  groupingUniverse: Concept[] = concepts,
  activeConflictConcepts?: { has(id: string): boolean },
): CanvasPresentation {
  if (displayMode !== 'grouped') return { concepts, groups: new Map() }

  const eligibility = new Map<string, number>()
  for (const concept of groupingUniverse) {
    const folder = conceptFolder(concept)
    if (!folder) continue
    const layer = primaryLayer(concept) ?? 'company'
    const key = groupBucketKey(layer, folder)
    eligibility.set(key, (eligibility.get(key) ?? 0) + 1)
  }

  const buckets = new Map<string, Concept[]>()
  for (const concept of concepts) {
    const folder = conceptFolder(concept)
    if (!folder) continue
    const layer = primaryLayer(concept) ?? 'company'
    const key = groupBucketKey(layer, folder)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(concept)
    else buckets.set(key, [concept])
  }

  const eligible = new Map<string, CanvasConceptGroup>()
  const occupiedIds = new Set(groupingUniverse.map((concept) => concept.id))
  for (const [key, members] of buckets) {
    // Eligibility comes from the unhidden folder inventory. Hiding one member
    // of an exactly-four-item folder must not explode its summary into three
    // individual cards and increase visual noise.
    if ((eligibility.get(key) ?? 0) < GROUP_MIN_SIZE) continue
    const first = members[0]
    const layer = primaryLayer(first) ?? 'company'
    const folder = conceptFolder(first)!
    const id = groupId(layer, folder, occupiedIds)
    eligible.set(key, {
      id,
      folder,
      layer,
      concepts: members,
      conflictCount: members.filter((concept) =>
        conceptHasConflict(concept) || activeConflictConcepts?.has(concept.id)).length,
      draftCount: members.filter((concept) => concept.draft).length,
    })
  }

  const out: Concept[] = []
  const groups = new Map<string, CanvasConceptGroup>()
  const emitted = new Set<string>()
  for (const concept of concepts) {
    const folder = conceptFolder(concept)
    const layer = primaryLayer(concept) ?? 'company'
    const key = folder ? groupBucketKey(layer, folder) : ''
    const group = eligible.get(key)
    if (!group) {
      out.push(concept)
      continue
    }
    if (!emitted.has(group.id)) {
      emitted.add(group.id)
      groups.set(group.id, group)
      out.push({
        id: group.id,
        title: group.folder,
        type: 'folder',
        layers: [group.layer],
        conflict: group.conflictCount > 0,
        sections: [],
        detailLoaded: false,
      })
    }
  }
  return { concepts: out, groups }
}

function validatedHiddenTargets(saved: unknown): Set<string> {
  if (!Array.isArray(saved)) return new Set()
  const valid: string[] = []
  const seen = new Set<string>()
  let serializedChars = 2
  for (const value of saved.slice(0, MAX_HIDDEN_TARGETS)) {
    if (!isStoredHiddenTarget(value) || seen.has(value)) continue
    const entryChars = JSON.stringify(value).length + (valid.length > 0 ? 1 : 0)
    if (serializedChars + entryChars > MAX_HIDDEN_TOTAL_CHARS) break
    valid.push(value)
    seen.add(value)
    serializedChars += entryChars
  }
  return new Set(valid)
}

function browserHiddenTargets(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(CASCADE_HIDDEN_NODES_KEY) ?? '[]')
    return validatedHiddenTargets(saved)
  } catch {
    return new Set()
  }
}

function initialHiddenTargets(): Set<string> {
  const desktop = window.__CC_DESKTOP?.uiState?.initial.cascadeHiddenNodes
  return desktop ? validatedHiddenTargets(desktop) : browserHiddenTargets()
}

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

export function computeLayout(concepts: Concept[], displayMode: CascadeDisplayMode = 'cards') {
  const metrics = METRICS_BY_MODE[displayMode]
  const { nodeW, nodeH, ghostW, ghostH, gapX, rowGapY, colsPerRow } = metrics
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
  const rowOf = (column: number) => Math.floor(column / colsPerRow)
  const colOf = (column: number) => column % colsPerRow

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
    const pBand = pRows > 0 ? pRows * nodeH + (pRows - 1) * rowGapY : 0
    const gBand = gRows > 0 ? gRows * ghostH + (gRows - 1) * rowGapY : 0
    primaryBandH[id] = pBand
    laneTop[id] = cursor
    laneHeight[id] = LANE_PAD_TOP + pBand + (gRows > 0 ? GHOST_BAND_GAP + gBand : 0) + LANE_PAD_BOTTOM
    cursor += laneHeight[id] + LANE_GAP
  }
  const worldH = cursor - LANE_GAP

  const nodes: NodePos[] = assigned.map(({ c, column }) => {
    const lane = primaryLayer(c) ?? 'company'
    const x = START_X + colOf(column) * (nodeW + gapX)
    const y = laneTop[lane] + LANE_PAD_TOP + rowOf(column) * (nodeH + rowGapY)
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
          x: START_X + colOf(column) * (nodeW + gapX) + (nodeW - ghostW) / 2,
          y: laneTop[d.layer] + LANE_PAD_TOP + primaryBandH[d.layer] + GHOST_BAND_GAP + rowOf(column) * (ghostH + rowGapY),
        })
      }
    }
  })

  // worldW is bounded at COLS_PER_ROW columns regardless of N (fewer when the
  // cascade is sparse, so a small cascade carries no dead whitespace).
  const colsUsed = Math.min(Math.max(1, columnLayers.length), colsPerRow)
  const worldW = START_X + colsUsed * nodeW + Math.max(0, colsUsed - 1) * gapX + END_X
  const lanes: Record<LayerId, LaneGeometry> = {
    personal: { top: laneTop.personal, height: laneHeight.personal },
    team: { top: laneTop.team, height: laneHeight.team },
    company: { top: laneTop.company, height: laneHeight.company },
  }
  return { nodes, ghosts, worldW, worldH, lanes, metrics }
}

/** Cubic bezier between two vertically-separated anchor points. */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dy = Math.max(40, (y2 - y1) * 0.5)
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
}

function representedConceptCount(
  displayConcepts: Concept[],
  groups: ReadonlyMap<string, CanvasConceptGroup>,
): number {
  return displayConcepts.reduce((total, concept) => {
    const group = groups.get(concept.id)
    if (!group) return total + 1
    return total + group.concepts.length
  }, 0)
}

interface HiddenTargetRow {
  key: string
  label: string
  detail: string
  count: number
  conflictCount: number
}

interface HideMenuState {
  x: number
  y: number
  key: string
  label: string
  detail: string
  conflictCount: number
  kind: 'concept' | 'folder'
}

function hiddenTargetRows(
  concepts: Concept[],
  hiddenTargets: ReadonlySet<string>,
  activeConflictConcepts: { has(id: string): boolean },
): HiddenTargetRow[] {
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]))
  const folders = new Map<string, { count: number; conflictCount: number }>()
  for (const concept of concepts) {
    const folder = conceptFolder(concept)
    if (!folder) continue
    const key = groupBucketKey(primaryLayer(concept) ?? 'company', folder)
    const row = folders.get(key) ?? { count: 0, conflictCount: 0 }
    row.count += 1
    if (conceptHasConflict(concept) || activeConflictConcepts.has(concept.id)) row.conflictCount += 1
    folders.set(key, row)
  }
  return [...hiddenTargets].flatMap((key) => {
    if (key.startsWith('concept:')) {
      const id = key.slice('concept:'.length)
      const concept = conceptsById.get(id)
      return [{
        key,
        label: concept?.title ?? id,
        detail: id,
        count: concept ? 1 : 0,
        conflictCount: concept && (conceptHasConflict(concept) || activeConflictConcepts.has(concept.id)) ? 1 : 0,
      }]
    }
    const parsed = parseHiddenFolderKey(key)
    if (!parsed) return []
    const { layer, folder } = parsed
    const stats = folders.get(groupBucketKey(layer, folder)) ?? { count: 0, conflictCount: 0 }
    return [{
      key,
      label: `${folder}/`,
      detail: `${layerName(layer)} folder`,
      count: stats.count,
      conflictCount: stats.conflictCount,
    }]
  })
}

function CanvasInner({ keyboardSuspended = false }: { keyboardSuspended?: boolean }) {
  const { setSelConcept, setSelConflict, setView, conflicts, concepts, sources, mode } = useStoreData()
  const [displayMode, setDisplayMode] = useState<CascadeDisplayMode>(readCascadeDisplayMode)
  const [hiddenTargets, setHiddenTargets] = useState<Set<string>>(initialHiddenTargets)
  const [openFolderGroupId, setOpenFolderGroupId] = useState<string | null>(null)
  const [folderQuery, setFolderQuery] = useState('')
  const [folderVisibleLimit, setFolderVisibleLimit] = useState(FOLDER_PAGE_SIZE)
  const [hiddenManagerOpen, setHiddenManagerOpen] = useState(false)
  const [hideMenu, setHideMenu] = useState<HideMenuState | null>(null)
  const displayHydrationPending = useRef(Boolean(window.__CC_DESKTOP?.uiState?.get))
  const displayChangedDuringHydration = useRef(false)
  const [hiddenStateHydrated, setHiddenStateHydrated] = useState(() => !window.__CC_DESKTOP?.uiState?.get)
  const hiddenHydrationStatus = useRef<'pending' | 'ready' | 'failed'>(
    window.__CC_DESKTOP?.uiState?.get ? 'pending' : 'ready',
  )
  const pendingHiddenOperations = useRef<Array<(current: Set<string>) => Set<string>>>([])
  const commitHiddenTargets = useCallback((update: (current: Set<string>) => Set<string>) => {
    if (hiddenHydrationStatus.current === 'pending') pendingHiddenOperations.current.push(update)
    setHiddenTargets((current) => validatedHiddenTargets([...update(current)]))
  }, [])
  useEffect(() => onCascadeDisplayModeChange((mode) => {
    if (displayHydrationPending.current) displayChangedDuringHydration.current = true
    setDisplayMode(mode)
  }), [])
  useEffect(() => onCascadeHiddenNodesChange(() => commitHiddenTargets(() => browserHiddenTargets())), [commitHiddenTargets])
  useEffect(() => {
    const getUiState = window.__CC_DESKTOP?.uiState?.get
    if (!getUiState) return
    let active = true
    getUiState().then((state) => {
      if (!active) return
      // The launch snapshot is immutable. Settings can change (or reset) this
      // preference while Cascade is unmounted, so the authoritative live
      // state must win when the view is opened again.
      if (!displayChangedDuringHydration.current) setDisplayMode(state.cascadeDisplay)
      displayHydrationPending.current = false
      let next = validatedHiddenTargets(state.cascadeHiddenNodes)
      for (const update of pendingHiddenOperations.current) next = validatedHiddenTargets([...update(next)])
      pendingHiddenOperations.current = []
      hiddenHydrationStatus.current = 'ready'
      setHiddenTargets(next)
      setHiddenStateHydrated(true)
    }).catch(() => {
      if (!active) return
      displayHydrationPending.current = false
      hiddenHydrationStatus.current = 'failed'
      pendingHiddenOperations.current = []
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!hiddenStateHydrated || hiddenHydrationStatus.current !== 'ready') return
    const next = [...hiddenTargets]
    try { localStorage.setItem(CASCADE_HIDDEN_NODES_KEY, JSON.stringify(next)) } catch { /* optional preference */ }
    window.__CC_DESKTOP?.uiState?.set({ cascadeHiddenNodes: next }).catch(() => {})
  }, [hiddenStateHydrated, hiddenTargets])

  const conflictsByConcept = useMemo(() => {
    const grouped = new Map<string, Conflict[]>()
    for (const conflict of conflicts) {
      const entries = grouped.get(conflict.concept)
      if (entries) entries.push(conflict)
      else grouped.set(conflict.concept, [conflict])
    }
    return grouped
  }, [conflicts])
  const actionableConflicts = useMemo(() => conflicts.filter((conflict) => {
    const status = conflict.discrepancyStatus ?? (conflict.status === 'open' ? 'needs_review' : 'resolved')
    return ACTIONABLE_DISCREPANCY_STATUSES.has(status)
  }), [conflicts])
  const actionableConflictsByConcept = useMemo(() => {
    const grouped = new Map<string, Conflict[]>()
    for (const conflict of actionableConflicts) {
      const entries = grouped.get(conflict.concept)
      if (entries) entries.push(conflict)
      else grouped.set(conflict.concept, [conflict])
    }
    return grouped
  }, [actionableConflicts])

  // User-hidden targets are removed before grouping and capping. A hidden
  // folder remains a durable preference even when new concepts arrive inside
  // it; conflicts remain counted in the summary and available in Review.
  const visibleConcepts = useMemo(
    () => concepts.filter((concept) => !isConceptHidden(concept, hiddenTargets)),
    [concepts, hiddenTargets],
  )
  const userHiddenConcepts = useMemo(
    () => concepts.filter((concept) => isConceptHidden(concept, hiddenTargets)),
    [concepts, hiddenTargets],
  )
  const hiddenRows = useMemo(
    () => hiddenTargetRows(concepts, hiddenTargets, actionableConflictsByConcept),
    [actionableConflictsByConcept, concepts, hiddenTargets],
  )
  const hiddenConflictCount = useMemo(
    () => userHiddenConcepts.filter((concept) =>
      conceptHasConflict(concept) || actionableConflictsByConcept.has(concept.id)).length,
    [actionableConflictsByConcept, userHiddenConcepts],
  )

  // Group before capping. A 162-note journal folder becomes one representative
  // node instead of being arbitrarily sliced at note 60. Opening a folder is a
  // separate overlay and never mutates the graph's geometry.
  const presentation = useMemo(
    () => buildCanvasPresentation(visibleConcepts, displayMode, concepts, actionableConflictsByConcept),
    [visibleConcepts, displayMode, concepts, actionableConflictsByConcept],
  )
  const capped = useMemo(() => capConceptsPerLane(presentation.concepts), [presentation.concepts])
  // Memoized: pan/zoom re-renders every pointermove — don't re-lay-out for those.
  const { nodes, ghosts, worldW, worldH, lanes, metrics } = useMemo(
    () => computeLayout(capped.concepts, displayMode),
    [capped.concepts, displayMode],
  )
  const represented = useMemo(
    () => representedConceptCount(capped.concepts, presentation.groups),
    [capped.concepts, presentation.groups],
  )
  const capHiddenConceptCount = Math.max(0, visibleConcepts.length - represented)
  // Full counts, not the capped subset — the lane header's "N concepts" stays
  // an honest visible total even while the canvas only renders some of them.
  const laneCounts = useMemo(() => countByLane(visibleConcepts), [visibleConcepts])
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
  const folderOpener = useRef<HTMLButtonElement | null>(null)
  const folderPanelRef = useRef<HTMLElement | null>(null)
  const hideMenuRef = useRef<HTMLDivElement | null>(null)
  const hideMenuOpener = useRef<HTMLElement | null>(null)
  const focusHideMenu = useRef(false)
  const hiddenSummaryRef = useRef<HTMLButtonElement | null>(null)

  const closeFolderBrowser = useCallback((restoreFocus = true) => {
    setOpenFolderGroupId(null)
    setFolderQuery('')
    setFolderVisibleLimit(FOLDER_PAGE_SIZE)
    if (restoreFocus) requestAnimationFrame(() => folderOpener.current?.focus())
  }, [])

  const openFolderBrowser = useCallback((id: string, opener: HTMLButtonElement) => {
    folderOpener.current = opener
    setHiddenManagerOpen(false)
    setHideMenu(null)
    setFolderQuery('')
    setFolderVisibleLimit(FOLDER_PAGE_SIZE)
    setOpenFolderGroupId((current) => current === id ? null : id)
  }, [])

  const closeHideMenu = useCallback((restoreFocus = false) => {
    setHideMenu(null)
    if (restoreFocus) requestAnimationFrame(() => hideMenuOpener.current?.focus())
  }, [])

  const openHideMenuAt = useCallback((
    x: number,
    y: number,
    target: Omit<HideMenuState, 'x' | 'y'>,
    opener: HTMLElement,
    moveFocus: boolean,
  ) => {
    hideMenuOpener.current = opener
    focusHideMenu.current = moveFocus
    setHiddenManagerOpen(false)
    setHideMenu({
      ...target,
      x: Math.max(8, Math.min(x, window.innerWidth - 244)),
      y: Math.max(8, Math.min(y, window.innerHeight - 150)),
    })
  }, [])

  const onTargetContextMenu = useCallback((event: React.MouseEvent, target: Omit<HideMenuState, 'x' | 'y'>) => {
    event.preventDefault()
    event.stopPropagation()
    openHideMenuAt(event.clientX, event.clientY, target, event.currentTarget as HTMLElement, false)
  }, [openHideMenuAt])

  const onTargetKeyDown = useCallback((event: React.KeyboardEvent, target: Omit<HideMenuState, 'x' | 'y'>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    openHideMenuAt(
      rect.left + Math.min(rect.width - 12, 36),
      rect.top + Math.min(rect.height - 8, 32),
      target,
      event.currentTarget as HTMLElement,
      true,
    )
  }, [openHideMenuAt])

  const hideTarget = useCallback((target: HideMenuState) => {
    commitHiddenTargets((current) => new Set(current).add(target.key))
    setHideMenu(null)
    setOpenFolderGroupId(null)
    requestAnimationFrame(() => hiddenSummaryRef.current?.focus())
  }, [commitHiddenTargets])

  const restoreTarget = useCallback((key: string) => {
    commitHiddenTargets((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [commitHiddenTargets])

  const openFolder = openFolderGroupId ? presentation.groups.get(openFolderGroupId) ?? null : null
  const folderResults = useMemo(() => {
    if (!openFolder) return []
    return filterFolderConcepts(openFolder.concepts, folderQuery)
  }, [folderQuery, openFolder])
  const visibleFolderResults = folderResults.slice(0, folderVisibleLimit)
  const remainingFolderResults = Math.max(0, folderResults.length - visibleFolderResults.length)
  useEffect(() => {
    if (openFolderGroupId && !openFolder) setOpenFolderGroupId(null)
  }, [openFolder, openFolderGroupId])
  useEffect(() => {
    if (!openFolder) return
    requestAnimationFrame(() => folderPanelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus())
  }, [openFolder])
  useEffect(() => {
    if (!hideMenu || !focusHideMenu.current) return
    focusHideMenu.current = false
    requestAnimationFrame(() => hideMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
  }, [hideMenu])
  useEffect(() => {
    if (keyboardSuspended || (!openFolder && !hiddenManagerOpen && !hideMenu)) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (hideMenu) closeHideMenu(true)
      else if (hiddenManagerOpen) setHiddenManagerOpen(false)
      else closeFolderBrowser()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeFolderBrowser, closeHideMenu, hiddenManagerOpen, hideMenu, keyboardSuspended, openFolder])

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
    setHideMenu(null)
    setHiddenManagerOpen(false)
    closeFolderBrowser(false)
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

  const openConcept = (c: Concept, opener: HTMLButtonElement) => {
    inspectorOpener.current = opener
    setOpenFolderGroupId(null)
    setHiddenManagerOpen(false)
    setHideMenu(null)
    setOpenId(c.id)
    setSelConcept(c.id)
  }
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
                  d={edgePath(g.parent.x + metrics.nodeW / 2, g.parent.y + metrics.nodeH, g.x + metrics.ghostW / 2, g.y)}
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
            const hideConceptTarget = {
              key: hiddenKeyForConcept(g.parent.c.id),
              label: g.parent.c.title,
              detail: g.parent.c.id,
              conflictCount: 1,
              kind: 'concept' as const,
            }
            return (
              <button
                key={g.key}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(event) => openConflictFor(g.parent.c.id, event.currentTarget, g.sectionKey)}
                onContextMenu={(event) => onTargetContextMenu(event, hideConceptTarget)}
                onKeyDown={(event) => onTargetKeyDown(event, hideConceptTarget)}
                onMouseEnter={() => setHoverId(g.parent.c.id)}
                onMouseLeave={() => setHoverId(null)}
                title="Layers disagree — open the conflict"
                aria-label={`${g.parent.c.title} — ${layerName(g.layer)} dissents, has conflict`}
                className="cc-canvas-ghost"
                data-display={displayMode}
                style={{ position: 'absolute', left: g.x, top: g.y, width: metrics.ghostW, height: metrics.ghostH }}
              >
                <div style={css('display:flex; align-items:center; gap:7px;')}>
                  <LayerChip id={g.layer} />
                  <span style={css(`font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:${C.amberText};`)}>overridden</span>
                </div>
                <div style={css(`font-size:${displayMode === 'cards' ? '11.5px' : '10.5px'}; color:${col.text2}; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`)}>{g.value}</div>
              </button>
            )
          })}

          {/* concept nodes */}
          {nodes.map((n) => {
            const col = lc(primaryLayer(n.c))
            const group = presentation.groups.get(n.c.id)
            const selected = openId === n.c.id
            const hasConflict = n.conflict || actionableConflictsByConcept.has(n.c.id)
            if (group) {
              const isOpen = openFolder?.id === group.id
              const hideGroupTarget = {
                key: hiddenKeyForFolder(group.layer, group.folder),
                label: `${group.folder}/`,
                detail: `${group.concepts.length} concepts`,
                conflictCount: group.conflictCount,
                kind: 'folder' as const,
              }
              return (
                <button
                  key={group.id}
                  type="button"
                  className="cc-canvas-group"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => openFolderBrowser(group.id, event.currentTarget)}
                  onContextMenu={(event) => onTargetContextMenu(event, hideGroupTarget)}
                  onKeyDown={(event) => onTargetKeyDown(event, hideGroupTarget)}
                  onMouseEnter={() => setHoverId(group.id)}
                  onMouseLeave={() => setHoverId(null)}
                  aria-haspopup="dialog"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? 'cc-canvas-folder-browser' : undefined}
                  aria-label={`Open ${group.folder} folder — ${group.concepts.length} concepts${group.conflictCount ? `, ${group.conflictCount} with conflicts` : ''}`}
                  title="Open folder · Right-click for options"
                  style={{ position: 'absolute', left: n.x, top: n.y, width: metrics.nodeW, height: metrics.nodeH }}
                >
                  <span className="cc-canvas-group-icon" style={{ color: col.text, background: col.fill }} aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 9.5v-3a2 2 0 0 1 2-2h4l1.8 2H18" /></svg>
                  </span>
                  <span className="cc-canvas-group-copy">
                    <strong>{group.folder}<span aria-hidden="true">/</span></strong>
                    <span>{NUM.format(group.concepts.length)} concepts{group.conflictCount > 0 && <> · <em>{NUM.format(group.conflictCount)} conflict{group.conflictCount === 1 ? '' : 's'}</em></>}{group.draftCount > 0 && <> · {NUM.format(group.draftCount)} draft{group.draftCount === 1 ? '' : 's'}</>}</span>
                  </span>
                  <svg className="cc-canvas-group-chevron" data-expanded={isOpen} viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
                </button>
              )
            }
            const hideConceptTarget = {
              key: hiddenKeyForConcept(n.c.id),
              label: n.c.title,
              detail: n.c.id,
              conflictCount: hasConflict ? 1 : 0,
              kind: 'concept' as const,
            }
            const supportingText = conceptSupportingText(n.c)
            return (
              <button
                key={n.c.id}
                type="button"
                className="cc-canvas-node"
                data-display={displayMode}
                data-selected={selected}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(event) => onTargetContextMenu(event, hideConceptTarget)}
                onKeyDown={(event) => onTargetKeyDown(event, hideConceptTarget)}
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
                title="Open concept · Right-click for options"
                style={{ position: 'absolute', left: n.x, top: n.y, width: metrics.nodeW, height: metrics.nodeH, borderColor: selected ? col.strokeE : undefined }}
              >
                <span className="cc-canvas-node-dot" style={{ background: col.strokeE }} aria-hidden="true" />
                <span className="cc-canvas-node-copy" data-single-line={!supportingText}>
                  {displayMode === 'cards' && <span className="cc-canvas-node-type" style={{ color: col.text, background: col.fill }}>{n.c.type}</span>}
                  <strong>{n.c.title}</strong>
                  {supportingText && <code>{supportingText}</code>}
                </span>
                {hasConflict && (
                  <span data-role="conflict-badge" className="cc-canvas-node-state" title="Layers disagree — click to resolve">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                    {displayMode === 'cards' && <span>conflict</span>}
                  </span>
                )}
                {n.c.draft && !hasConflict && <span className="cc-canvas-node-draft">draft</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="cc-canvas-viewbar" onPointerDown={(event) => event.stopPropagation()}>
        <div className="cc-canvas-summary" aria-live="polite">
          {capHiddenConceptCount > 0 ? (
            <span>Showing <strong>{NUM.format(represented)}</strong> of {NUM.format(visibleConcepts.length)} visible</span>
          ) : (
            <span><strong>{NUM.format(visibleConcepts.length)}</strong> {userHiddenConcepts.length > 0 ? 'visible' : 'concepts'}</span>
          )}
          {presentation.groups.size > 0 && <span className="cc-canvas-summary-muted">· {NUM.format(presentation.groups.size)} folder group{presentation.groups.size === 1 ? '' : 's'}</span>}
          {userHiddenConcepts.length > 0 && (
            <button
              ref={hiddenSummaryRef}
              type="button"
              className="cc-canvas-summary-hidden"
              data-has-conflict={hiddenConflictCount > 0}
              aria-expanded={hiddenManagerOpen}
              aria-controls={hiddenManagerOpen ? 'cc-canvas-hidden-manager' : undefined}
              title={hiddenConflictCount > 0 ? `${hiddenConflictCount} hidden concept${hiddenConflictCount === 1 ? '' : 's'} still ${hiddenConflictCount === 1 ? 'has' : 'have'} conflicts` : 'Manage hidden Cascade nodes'}
              onClick={() => {
                setOpenFolderGroupId(null)
                setHideMenu(null)
                setHiddenManagerOpen((open) => !open)
              }}
            >· {NUM.format(userHiddenConcepts.length)} hidden{hiddenConflictCount > 0 ? ` · ${NUM.format(hiddenConflictCount)} conflicted` : ''}</button>
          )}
          {actionableConflicts.length > 0 && (
            <button type="button" className="cc-canvas-summary-conflicts" onClick={() => setView('conflicts')}>
              · {NUM.format(actionableConflicts.length)} conflict{actionableConflicts.length === 1 ? '' : 's'}
            </button>
          )}
          {capHiddenConceptCount > 0 && (
            <button type="button" className="cc-canvas-summary-browse" onClick={() => setView('concepts')}>Browse all</button>
          )}
        </div>

      </div>

      {openFolder && (
        <section
          id="cc-canvas-folder-browser"
          ref={folderPanelRef}
          className="cc-canvas-folder-browser"
          role="dialog"
          aria-modal="false"
          aria-label={`${openFolder.folder} folder`}
          onPointerDown={(event) => event.stopPropagation()}
          style={{ borderTopColor: lc(openFolder.layer).strokeE }}
        >
          <header>
            <div className="cc-canvas-panel-heading">
              <span className="cc-canvas-panel-folder-icon" style={{ color: lc(openFolder.layer).text, background: lc(openFolder.layer).fill }} aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 9.5v-3a2 2 0 0 1 2-2h4l1.8 2H18" /></svg>
              </span>
              <span>
                <small className="cc-canvas-panel-kicker">{layerName(openFolder.layer)} folder</small>
                <strong>{openFolder.folder}<span aria-hidden="true">/</span></strong>
                <span className="cc-canvas-folder-facts">
                  <span>{NUM.format(openFolder.concepts.length)} concepts</span>
                  {openFolder.conflictCount > 0 && <em>{NUM.format(openFolder.conflictCount)} conflict{openFolder.conflictCount === 1 ? '' : 's'}</em>}
                  {openFolder.draftCount > 0 && <span>{NUM.format(openFolder.draftCount)} draft{openFolder.draftCount === 1 ? '' : 's'}</span>}
                </span>
              </span>
            </div>
            <button type="button" className="cc-canvas-panel-close" onClick={() => closeFolderBrowser()} aria-label={`Close ${openFolder.folder} folder`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </header>
          <div className="cc-canvas-folder-toolbar">
            <div className="cc-canvas-folder-search" role="search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input
                data-autofocus
                type="search"
                value={folderQuery}
                onChange={(event) => {
                  setFolderQuery(event.target.value)
                  setFolderVisibleLimit(FOLDER_PAGE_SIZE)
                }}
                placeholder={`Filter ${openFolder.folder}/`}
                aria-label={`Filter ${openFolder.folder} concepts`}
              />
              {folderQuery && (
                <button type="button" onClick={() => {
                  setFolderQuery('')
                  setFolderVisibleLimit(FOLDER_PAGE_SIZE)
                }} aria-label="Clear folder filter">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
                </button>
              )}
            </div>
            {folderQuery && <span aria-live="polite">{NUM.format(folderResults.length)} of {NUM.format(openFolder.concepts.length)}</span>}
          </div>
          <div className="cc-canvas-folder-list">
            {visibleFolderResults.map((concept) => {
              const hasConflict = conceptHasConflict(concept) || actionableConflictsByConcept.has(concept.id)
              const supportingText = conceptSupportingText(concept)
              const hideConceptTarget = {
                key: hiddenKeyForConcept(concept.id),
                label: concept.title,
                detail: concept.id,
                conflictCount: hasConflict ? 1 : 0,
                kind: 'concept' as const,
              }
              return (
                <button
                  key={concept.id}
                  type="button"
                  className="cc-canvas-folder-item"
                  onClick={(event) => openConcept(concept, folderOpener.current ?? event.currentTarget)}
                  onContextMenu={(event) => onTargetContextMenu(event, hideConceptTarget)}
                  onKeyDown={(event) => onTargetKeyDown(event, hideConceptTarget)}
                  title="Open concept · Right-click for options"
                  aria-label={`${concept.title} — ${concept.id}${hasConflict ? ', has conflict' : concept.draft ? ', draft' : ''}`}
                >
                  <span className="cc-canvas-node-dot" style={{ background: lc(primaryLayer(concept) ?? 'company').strokeE }} aria-hidden="true" />
                  <span>
                    <strong>{concept.title}</strong>
                    {supportingText && <code>{supportingText}</code>}
                  </span>
                  {hasConflict && <span className="cc-canvas-folder-state">conflict</span>}
                  {concept.draft && !hasConflict && <span className="cc-canvas-folder-state">draft</span>}
                  <svg className="cc-canvas-folder-open" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
                </button>
              )
            })}
            {remainingFolderResults > 0 && (
              <button
                type="button"
                className="cc-canvas-folder-more"
                onClick={() => setFolderVisibleLimit((current) => current + FOLDER_PAGE_SIZE)}
              >
                <strong>Show {NUM.format(Math.min(FOLDER_PAGE_SIZE, remainingFolderResults))} more</strong>
                <span>{NUM.format(remainingFolderResults)} remain</span>
              </button>
            )}
            {folderResults.length === 0 && (
              <div className="cc-canvas-folder-empty" role="status">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
                <strong>No matching concepts</strong>
                <span>Try a title, path, or type.</span>
              </div>
            )}
          </div>
          <footer className="cc-canvas-folder-footer">
            <span>Right-click a concept to hide it from Cascade.</span>
            <kbd>Esc</kbd>
          </footer>
        </section>
      )}

      {hiddenManagerOpen && hiddenRows.length > 0 && (
        <section
          id="cc-canvas-hidden-manager"
          className="cc-canvas-hidden-manager"
          role="dialog"
          aria-modal="false"
          aria-label="Hidden Cascade nodes"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header>
            <span>
              <strong>Hidden from Cascade</strong>
              <small>{NUM.format(userHiddenConcepts.length)} concept{userHiddenConcepts.length === 1 ? '' : 's'} concealed</small>
            </span>
            <button type="button" className="cc-canvas-panel-close" onClick={() => setHiddenManagerOpen(false)} aria-label="Close hidden nodes manager">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </header>
          <p>Hidden nodes stay available in Knowledge and Review.</p>
          <div className="cc-canvas-hidden-list">
            {hiddenRows.map((row) => (
              <div key={row.key} className="cc-canvas-hidden-row">
                <span>
                  <strong>{row.label}</strong>
                  <small>{row.detail}{row.count > 1 ? ` · ${NUM.format(row.count)} concepts` : ''}{row.conflictCount > 0 ? ` · ${NUM.format(row.conflictCount)} conflicted` : ''}</small>
                </span>
                <button type="button" onClick={() => restoreTarget(row.key)}>Show</button>
              </div>
            ))}
          </div>
          <footer>
            <button type="button" onClick={() => {
              commitHiddenTargets(() => new Set())
              setHiddenManagerOpen(false)
            }}>Show all hidden nodes</button>
          </footer>
        </section>
      )}

      {hideMenu && (
        <div
          ref={hideMenuRef}
          className="cc-canvas-context-menu"
          role="menu"
          aria-label={`${hideMenu.label} options`}
          style={{ left: hideMenu.x, top: hideMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              // Let the browser perform its normal Tab move, but dismiss the
              // context menu so it never floats over unrelated Canvas focus.
              closeHideMenu(false)
              return
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            hideMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeHideMenu(false)
          }}
        >
          <div className="cc-canvas-context-heading">
            <strong>{hideMenu.label}</strong>
            <span>{hideMenu.detail}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => hideTarget(hideMenu)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 5 9 5a16 16 0 0 1-2.1 2.6M6.2 6.2C4.1 7.6 3 9 3 9s3.5 5 9 5c1 0 1.9-.2 2.7-.4" /></svg>
            <span>
              <strong>Hide {hideMenu.kind === 'folder' ? 'folder' : 'node'} from Cascade</strong>
              <small>Restore it later from Hidden</small>
            </span>
          </button>
          {hideMenu.conflictCount > 0 && <p>{NUM.format(hideMenu.conflictCount)} conflict{hideMenu.conflictCount === 1 ? '' : 's'} will remain available in Review.</p>}
        </div>
      )}

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
      <div className="cc-canvas-legend" style={css('background:var(--cc-header-bg); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);')}>
        <div>The cascade — higher lanes win</div>
        <span className="cc-canvas-legend-rule" aria-hidden="true" />
        <span>a lower layer disagrees</span>
      </div>

      {/* zoom controls */}
      <div className="cc-canvas-zoom">
        {([['+', 'Zoom in', () => zoom(1)], ['−', 'Zoom out', () => zoom(-1)], ['⤢', 'Fit to view', fit]] as const).map(([label, name, fn]) => (
          <button
            key={name}
            className="cc-h-navbg"
            onClick={fn}
            title={name}
            aria-label={name}
          >{label}</button>
        ))}
      </div>

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
