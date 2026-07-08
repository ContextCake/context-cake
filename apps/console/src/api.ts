// Data source: the console's single seam to ContextCake data.
//
//   demo mode  — imports a bundle generated at build time by shelling out to the
//                real resolver (scripts/build-demo-data.mjs). Never hand-authored.
//   live mode  — same-origin HTTP against the playground server (/api/graph,
//                /api/resolve). Served under the playground's `/console/` mount.
//
// Live mode NEVER silently falls back to demo — an unreachable or malformed
// backend surfaces as a typed error the UI renders honestly (see store.tsx).
//
// The adapters at the bottom map the raw engine wire types (types.ts) onto the
// console's existing view model (data.ts), so views stay stable.

import demoBundleRaw from './generated/demo-cascade.json'
import type {
  DemoBundle, GraphSummary, GraphSource, ResolvedConcept, ResolvedSection,
} from './types'
import type { Concept, ConceptSection, Conflict, Dissent, Source } from './data'
import type { LayerId } from './theme'

const demoBundle = demoBundleRaw as unknown as DemoBundle

export type Mode = 'demo' | 'live'
export type LiveErrorKind = 'unreachable' | 'bad-status' | 'bad-shape'

/** A typed failure from the live backend. The UI branches on `.kind`. */
export class LiveDataError extends Error {
  kind: LiveErrorKind
  status?: number
  constructor(kind: LiveErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'LiveDataError'
    this.kind = kind
    this.status = status
  }
}

/** Bulk resolve result: per-concept failures never sink the whole load. */
export interface ResolveAllResult {
  concepts: ResolvedConcept[]
  errors: { concept: string; error: string }[]
}

export interface DataSource {
  readonly mode: Mode
  graph(): Promise<GraphSummary>
  resolve(id: string): Promise<ResolvedConcept>
  /** Resolve every concept in one pass (one request / one sources-open in live mode). */
  resolveAll(): Promise<ResolveAllResult>
  listConcepts(): Promise<string[]>
}

// ---- Mode selection --------------------------------------------------------

/**
 * demo unless explicitly live: `?mode=live`, or being served under the
 * playground's `/console/` static mount (same-origin `/api/*` available).
 */
export function selectMode(): Mode {
  if (typeof window === 'undefined') return 'demo'
  const params = new URLSearchParams(window.location.search)
  const forced = params.get('mode')
  if (forced === 'live') return 'live'
  if (forced === 'demo') return 'demo'
  if (window.location.pathname.startsWith('/console')) return 'live'
  return 'demo'
}

// ---- Sources ---------------------------------------------------------------

class DemoSource implements DataSource {
  readonly mode = 'demo'
  private bundle: DemoBundle
  constructor(bundle: DemoBundle) { this.bundle = bundle }
  async graph(): Promise<GraphSummary> { return this.bundle.graph }
  async resolve(id: string): Promise<ResolvedConcept> {
    const c = this.bundle.concepts.find((x) => x.id === id)
    if (!c) throw new LiveDataError('bad-status', `Unknown concept: ${id}`, 404)
    return c
  }
  async resolveAll(): Promise<ResolveAllResult> {
    return { concepts: this.bundle.concepts, errors: [] }
  }
  async listConcepts(): Promise<string[]> { return this.bundle.concepts.map((c) => c.id) }
}

class LiveSource implements DataSource {
  readonly mode = 'live'
  async graph(): Promise<GraphSummary> { return this.get<GraphSummary>('/api/graph') }
  async resolve(id: string): Promise<ResolvedConcept> {
    return this.get<ResolvedConcept>(`/api/resolve?concept=${encodeURIComponent(id)}`)
  }
  async resolveAll(): Promise<ResolveAllResult> {
    try {
      return await this.get<ResolveAllResult>('/api/resolve-all')
    } catch (e) {
      // An older server without the bulk endpoint: fall back to per-concept
      // requests, bounded so we don't stampede it (each /api/resolve re-opens
      // every source server-side).
      if (!(e instanceof LiveDataError && e.kind === 'bad-status' && e.status === 404)) throw e
      const ids = await this.listConcepts()
      const concepts: ResolvedConcept[] = []
      const errors: { concept: string; error: string }[] = []
      const POOL = 6
      let next = 0
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++]
          try {
            concepts.push(await this.resolve(id))
          } catch (err) {
            errors.push({ concept: id, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(POOL, ids.length) }, worker))
      return { concepts, errors }
    }
  }
  async listConcepts(): Promise<string[]> {
    const g = await this.graph()
    return g.concepts.map((c) => c.id)
  }
  private async get<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(path, { headers: { accept: 'application/json' } })
    } catch {
      throw new LiveDataError('unreachable', `Cannot reach the ContextCake server (${path}). Is the playground running?`)
    }
    if (!res.ok) {
      throw new LiveDataError('bad-status', `Server returned ${res.status} for ${path}`, res.status)
    }
    try {
      return (await res.json()) as T
    } catch {
      throw new LiveDataError('bad-shape', `Malformed response from ${path}`)
    }
  }
}

export function createDataSource(mode: Mode = selectMode()): DataSource {
  return mode === 'live' ? new LiveSource() : new DemoSource(demoBundle)
}

// ---- Adapters: raw engine types → console view model -----------------------

const LAYER_IDS: LayerId[] = ['company', 'team', 'personal']
const isLayerId = (s: string): s is LayerId => (LAYER_IDS as string[]).includes(s)

/** Map a source/layer name (falling back to level) to a console LayerId. */
function layerOf(name: string, level: number): LayerId {
  if (isLayerId(name)) return name
  if (level >= 3) return 'personal'
  if (level === 2) return 'team'
  return 'company'
}

/** `## Choice {#choice}` → `Choice`. */
function headingText(heading: string): string {
  return heading.replace(/^#+\s*/, '').replace(/\s*\{#.*\}\s*$/, '').trim()
}

/** Order layers by precedence (personal → team → company) for chip display. */
function orderLayers(ids: LayerId[]): LayerId[] {
  const rank: Record<LayerId, number> = { personal: 0, team: 1, company: 2 }
  return [...new Set(ids)].sort((a, b) => rank[a] - rank[b])
}

/**
 * Layer name → precedence level, from the concept's own contributors. Every
 * `sections[].sourceLayer` and `conflicts[].layer` names a contributor, so
 * this lookup is total — and it keeps non-canonical layer names (e.g. a
 * live source named "acme-eng" at level 2) mapped to the right lane instead
 * of silently falling through to company.
 */
function contributorLevels(r: ResolvedConcept): Map<string, number> {
  return new Map(r.contributors.map((c) => [c.layer, c.level]))
}

/** A resolved section → the console's ConceptSection (with provenance + dissent). */
function adaptSection(s: ResolvedSection, levels: Map<string, number>): ConceptSection {
  const winner = layerOf(s.sourceLayer, levels.get(s.sourceLayer) ?? 0)
  const dissents: Dissent[] = (s.conflicts ?? []).map((c) => ({
    layer: layerOf(c.layer, levels.get(c.layer) ?? 0),
    value: c.content,
    updated: c.updated,
  }))
  return {
    name: headingText(s.heading),
    key: s.key,
    winner,
    value: s.content,
    updated: s.sourceUpdated,
    suppressed: s.suppressed === true,
    dissents,
  }
}

/** A resolved concept → the console's Concept. */
export function adaptConcept(r: ResolvedConcept): Concept {
  const levels = contributorLevels(r)
  const layerIds = orderLayers(r.contributors.map((c) => layerOf(c.layer, c.level)))
  const sections = r.sections.map((s) => adaptSection(s, levels))
  return {
    id: r.id,
    title: (r.frontmatter?.title as string) ?? r.id,
    type: (r.frontmatter?.type as string) ?? 'concept',
    layers: layerIds,
    conflict: sections.some((s) => (s.dissents?.length ?? 0) > 0),
    // The write path stamps auto-captured, unreviewed concepts with
    // `draft: true` in OKF frontmatter (write.mjs) — that is the only honest
    // draft signal. Owning a concept in a single layer does not make it draft.
    draft: r.frontmatter?.draft === true,
    sections,
  }
}

/** Graph sources → the console's Source[] (coverage/focus/status derived honestly). */
export function adaptSources(g: GraphSummary): Source[] {
  return g.sources.map((s: GraphSource) => {
    const errored = s.status === 'error'
    return {
      name: s.name,
      kind: s.kind === 'mcp' ? 'mcp' : 'okf-local',
      layer: layerOf(s.name, s.level),
      coverage: errored ? 0 : 100,
      focus: errored
        ? (s.error ?? 'unreachable')
        : `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'} · ${s.kind}`,
      status: errored ? 'error' : s.kind === 'mcp' ? 'serving' : 'synced',
    }
  })
}

/** Derive conflict cards from resolved concepts — one per conflicted section. */
export function adaptConflicts(concepts: ResolvedConcept[]): Conflict[] {
  const out: Conflict[] = []
  for (const c of concepts) {
    const title = (c.frontmatter?.title as string) ?? c.id
    const levels = contributorLevels(c)
    for (const s of c.sections) {
      if (!s.conflicts?.length) continue
      const winner = layerOf(s.sourceLayer, levels.get(s.sourceLayer) ?? 0)
      out.push({
        id: `${c.id}::${s.key}`,
        concept: c.id,
        section: headingText(s.heading),
        title: `${headingText(s.heading)} — ${title}`,
        status: 'open',
        winner,
        contributions: [
          { layer: winner, value: s.content, updated: s.sourceUpdated ?? '' },
          ...s.conflicts.map((k) => ({
            layer: layerOf(k.layer, levels.get(k.layer) ?? 0),
            value: k.content,
            updated: k.updated ?? '',
          })),
        ],
      })
    }
  }
  return out
}
