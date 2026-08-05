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
  ConflictResolutionRecord, DemoBundle, GraphSummary, GraphSource, ResolveConflictRequest,
  ResolvedConcept, ResolvedSection,
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
  /** Sources still being read — the result is partial until this clears. */
  indexing?: boolean
  indexingSources?: string[]
}

export interface DataSource {
  readonly mode: Mode
  graph(): Promise<GraphSummary>
  resolve(id: string): Promise<ResolvedConcept>
  /** Resolve every concept in one pass (one request / one sources-open in live mode). */
  resolveAll(): Promise<ResolveAllResult>
  listConcepts(): Promise<string[]>
  conflictResolutions(): Promise<ConflictResolutionRecord[]>
  resolveConflict(request: ResolveConflictRequest): Promise<ConflictResolutionRecord>
}

// ---- Transport --------------------------------------------------------------

/** Default deadline for engine API calls — no request may spin forever. */
export const API_TIMEOUT_MS = 60_000

/**
 * fetch for the same-origin engine API. Inside the desktop app the preload
 * bridge retrieves a per-launch bearer token through trusted IPC; the local
 * service requires it on every /api route. In a browser this is a plain fetch.
 * All renderer code hitting /api/* must go through this.
 *
 * Every call carries an abort deadline (callers can pass their own `signal`
 * to tighten it) so a stalled backend surfaces as a typed error instead of an
 * eternal spinner — the setup wizard's "Resolving…" hang.
 */
let desktopTokenPromise: Promise<string> | null = null

async function desktopToken(): Promise<string | undefined> {
  if (typeof window === 'undefined' || !window.__CC_DESKTOP) return undefined
  if (!desktopTokenPromise) {
    desktopTokenPromise = window.__CC_DESKTOP.getApiToken().catch((error) => {
      desktopTokenPromise = null
      throw error
    })
  }
  return desktopTokenPromise
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const withSignal: RequestInit = { ...init, signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) }
  const token = await desktopToken()
  if (!token) return fetch(path, withSignal)
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(path, { ...withSignal, headers })
}

/** True when a fetch rejection came from the request deadline, not the network. */
export function isTimeout(e: unknown): boolean {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
  return name === 'TimeoutError' || name === 'AbortError'
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
  private resolutions: ConflictResolutionRecord[] = []
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
  async conflictResolutions(): Promise<ConflictResolutionRecord[]> { return this.resolutions }
  async resolveConflict(request: ResolveConflictRequest): Promise<ConflictResolutionRecord> {
    const prior = request.resolutionId
      ? this.resolutions.find((item) => item.id === request.resolutionId)
      : undefined
    const concept = this.bundle.concepts.find((item) => item.id === request.conceptId)
    const section = concept?.sections.find((item) => item.key === request.sectionKey)
    if (!prior && (!concept || !section?.conflicts?.length)) throw new LiveDataError('bad-status', 'This conflict is no longer open.', 409)
    const levels = new Map(concept?.contributors.map((item) => [item.layer, item.level]) ?? [])
    const contributions = prior?.contributions ?? [
      { layer: section!.sourceLayer, level: levels.get(section!.sourceLayer), content: section!.content, updated: section!.sourceUpdated },
      ...section!.conflicts!.map((item) => ({ layer: item.layer, level: levels.get(item.layer), content: item.content, updated: item.updated })),
    ]
    const chosen = contributions.find((item) => item.layer === request.selectedLayer)
    if (!chosen) throw new LiveDataError('bad-status', 'That answer is no longer available.', 409)
    const reason = trivialConflictReason(contributions.map((item) => item.content))
    if (request.method === 'automatic' && (!reason || request.selectedLayer !== contributions[0].layer)) {
      throw new LiveDataError('bad-status', 'This conflict needs your judgment.', 409)
    }
    const record: ConflictResolutionRecord = {
      schemaVersion: 1,
      id: `demo-${Date.now()}-${this.resolutions.length + 1}`,
      conflictId: `${request.conceptId}::${request.sectionKey}`,
      conceptId: request.conceptId,
      title: String(prior?.title ?? concept?.frontmatter?.title ?? request.conceptId),
      sectionKey: request.sectionKey,
      sectionHeading: prior?.sectionHeading ?? section!.heading,
      contributions,
      chosen,
      method: request.method,
      reason: request.method === 'automatic' ? reason! : `You chose the ${request.selectedLayer} answer.`,
      actor: 'local-user',
      decidedAt: new Date().toISOString(),
      ...(prior ? { supersedes: prior.id } : {}),
    }
    this.resolutions.push(record)
    if (section) {
      section.content = chosen.content
      section.sourceLayer = chosen.layer
      section.sourceUpdated = chosen.updated
      delete section.conflicts
      delete section.fresherDissent
    }
    return record
  }
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
  async conflictResolutions(): Promise<ConflictResolutionRecord[]> {
    try {
      return (await this.get<{ resolutions: ConflictResolutionRecord[] }>('/api/conflict-resolutions')).resolutions
    } catch (error) {
      // Compatibility with an older read-only service: conflicts still render,
      // but no past decisions are invented.
      if (error instanceof LiveDataError && error.kind === 'bad-status' && error.status === 404) return []
      throw error
    }
  }
  async resolveConflict(request: ResolveConflictRequest): Promise<ConflictResolutionRecord> {
    const response = await this.request<{ resolution: ConflictResolutionRecord }>('/api/conflict-resolutions', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return response.resolution
  }
  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { headers: { accept: 'application/json' } })
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await apiFetch(path, init)
    } catch (e) {
      throw new LiveDataError(
        'unreachable',
        isTimeout(e)
          ? `The ContextCake server took too long to respond (${path}). A source may be very large or unreachable.`
          : `Cannot reach the ContextCake server (${path}). Is the playground running?`,
      )
    }
    if (!res.ok) {
      let detail = ''
      try {
        const body = await res.clone().json() as { error?: unknown }
        if (typeof body.error === 'string') detail = body.error
      } catch { /* keep the status fallback */ }
      throw new LiveDataError('bad-status', detail || `Server returned ${res.status} for ${path}`, res.status)
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

/**
 * C-b day-granularity freshness: true only when both dates parse
 * (`new Date(v).getTime()` valid) and the dissent's calendar day
 * (`slice(0,10)`) is strictly after the winner's. A datetime on the same day
 * as a date-only value must not count as newer, and a missing or unparseable
 * date on either side is never treated as epoch 0.
 */
function newerAtDayGranularity(dissentUpdated: string | null, winnerUpdated: string | null): boolean {
  if (!dissentUpdated || !winnerUpdated) return false
  if (Number.isNaN(new Date(dissentUpdated).getTime()) || Number.isNaN(new Date(winnerUpdated).getTime())) return false
  const dissentDay = new Date(dissentUpdated.slice(0, 10)).getTime()
  const winnerDay = new Date(winnerUpdated.slice(0, 10)).getTime()
  if (Number.isNaN(dissentDay) || Number.isNaN(winnerDay)) return false
  return dissentDay > winnerDay
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
    ...(s.fresherDissent === true ? { fresherDissent: true } : {}),
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
    // A remote source that can't reach its API doesn't throw — it answers with
    // nothing. The engine marks that 'degraded'; surfacing it as healthy would
    // put a green dot over an outage, which is the one thing this row is for.
    const degraded = s.status === 'degraded'
    const count = `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`
    // An MCP child that died after startup used to keep its green "serving"
    // dot: the adapter answers [] instead of throwing, so a dead server and an
    // empty graph produced the same row. "Serving" now requires evidence —
    // at least one concept actually served and no recorded failure.
    const status = errored
      ? 'error' as const
      : degraded
        ? 'degraded' as const
        : s.kind === 'mcp'
          ? (s.conceptCount > 0 && !s.error ? 'serving' as const : s.error ? 'degraded' as const : 'empty' as const)
          : 'synced' as const
    return {
      name: s.name,
      kind: s.kind === 'mcp' ? 'mcp' : 'okf-local',
      layer: layerOf(s.name, s.level),
      // A source contributing nothing shouldn't show a full bar, however it
      // got there — errored, degraded to empty, or genuinely empty.
      coverage: errored || s.conceptCount === 0 ? 0 : 100,
      focus: errored
        ? (s.error ?? 'unreachable')
        : degraded
          ? `${count} · ${s.lastSuccessAt ? `as of ${s.lastSuccessAt} · ` : ''}${s.error ?? 'source unreachable'}`
          : status === 'empty'
            ? `${count} · ${s.kind} — nothing served yet`
            : `${count} · ${s.kind}`,
      status,
      // Management fields (Sources view): the raw engine kind plus health
      // timestamps ride along so remove/rename/sync can render honestly.
      sourceKind: s.kind,
      authAlias: s.authAlias ?? null,
      authState: s.authState ?? 'anonymous',
      level: s.level,
      conceptCount: s.conceptCount,
      origin: s.origin ?? null,
      error: s.error ?? null,
      lastSuccessAt: s.lastSuccessAt ?? null,
      lastErrorAt: s.lastErrorAt ?? null,
      ...(s.live === true ? { live: true } : {}),
    }
  })
}

/** Same conservative classifier the service enforces for the magic wand. */
export function trivialConflictReason(values: string[]): string | null {
  if (values.length < 2) return null
  const signatures = values.map((value) => {
    if (!value.trim() || /```|~~~|`|!?\[[^\]]*\]\(|<\/?[a-z][^>]*>|https?:\/\/|\|[^\n]*\|/i.test(value)) return null
    const tokens = value.normalize('NFKC').replace(/[*_~]/g, '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)
    return tokens?.length ? tokens.join('\u001f') : null
  })
  return signatures.some((value) => value === null) || new Set(signatures).size !== 1
    ? null
    : 'The answers use the same words in the same order; only formatting differs.'
}

/** Derive open conflicts plus resolved decisions retained by the local log. */
export function adaptConflicts(concepts: ResolvedConcept[], resolutions: ConflictResolutionRecord[] = []): Conflict[] {
  const out: Conflict[] = []
  const historyByConflict = new Map<string, ConflictResolutionRecord[]>()
  for (const resolution of resolutions) {
    const history = historyByConflict.get(resolution.conflictId) ?? []
    history.push(resolution)
    historyByConflict.set(resolution.conflictId, history)
  }
  for (const c of concepts) {
    const title = (c.frontmatter?.title as string) ?? c.id
    const levels = contributorLevels(c)
    for (const s of c.sections) {
      if (!s.conflicts?.length) continue
      const winner = layerOf(s.sourceLayer, levels.get(s.sourceLayer) ?? 0)
      const id = `${c.id}::${s.key}`
      const history = historyByConflict.get(id) ?? []
      const contributions = [
        { layer: winner, sourceLayer: s.sourceLayer, value: s.content, updated: s.sourceUpdated ?? '' },
        ...s.conflicts.map((k) => ({
          layer: layerOf(k.layer, levels.get(k.layer) ?? 0),
          sourceLayer: k.layer,
          value: k.content,
          updated: k.updated ?? '',
          ...(s.fresherDissent === true && newerAtDayGranularity(k.updated, s.sourceUpdated)
            ? { fresherDissent: true }
            : {}),
        })),
      ]
      out.push({
        id,
        concept: c.id,
        sectionKey: s.key,
        section: headingText(s.heading),
        title: `${headingText(s.heading)} — ${title}`,
        // A conflict present in current resolver output is open even if an
        // older decision exists: a source changed after that decision.
        status: 'open',
        winner,
        contributions,
        safe: trivialConflictReason(contributions.map((item) => item.value)) !== null,
        history,
      })
    }
  }
  // Once source files agree, the resolver no longer emits a conflict. Keep it
  // visible from the durable record so “resolved” never means “forgotten”.
  for (const [id, history] of historyByConflict) {
    if (out.some((item) => item.id === id)) continue
    const latest = history[history.length - 1]
    const contributions = latest.contributions.map((item) => ({
      layer: layerOf(item.layer, item.level ?? (item.layer === 'personal' ? 3 : item.layer === 'team' ? 2 : 0)),
      sourceLayer: item.layer,
      value: item.content,
      updated: item.updated ?? '',
    }))
    out.push({
      id,
      concept: latest.conceptId,
      sectionKey: latest.sectionKey,
      section: headingText(latest.sectionHeading),
      title: `${headingText(latest.sectionHeading)} — ${latest.title}`,
      status: 'resolved',
      winner: layerOf(latest.chosen.layer, latest.chosen.level ?? (latest.chosen.layer === 'personal' ? 3 : latest.chosen.layer === 'team' ? 2 : 0)),
      contributions,
      safe: false,
      history,
    })
  }
  return out
}
