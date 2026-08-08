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
  ConflictResolutionRecord, DemoBundle, DiscrepanciesResponse, DiscrepancyDecisionRequest, DiscrepancyRecord,
  DiscrepancyRule, DiscrepancyRuleSuggestion, GraphSummary, GraphSource, ResolveConflictRequest,
  ResolvedConcept, ResolvedSection, SourceStatus, StatusSummary,
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
  /**
   * The cheap progress/health poll. `null` means this backend has no
   * `/api/status` route (an engine older than the console) — callers fall back
   * to reading progress off the graph.
   */
  status(): Promise<StatusSummary | null>
  conflictResolutions(): Promise<ConflictResolutionRecord[]>
  resolveConflict(request: ResolveConflictRequest): Promise<ConflictResolutionRecord>
  discrepancies(): Promise<DiscrepanciesResponse | null>
  decideDiscrepancy(request: DiscrepancyDecisionRequest): Promise<ConflictResolutionRecord>
  discrepancyRules(): Promise<{ rules: DiscrepancyRule[]; suggestions: DiscrepancyRuleSuggestion[] }>
  createDiscrepancyRule(suggestionId: string): Promise<DiscrepancyRule>
  patchDiscrepancyRule(id: string, changes: { mode?: 'recommend' | 'automatic'; enabled?: boolean }): Promise<DiscrepancyRule>
  promoteDiscrepancyRule(id: string, confirm: boolean): Promise<Record<string, unknown>>
  setDiscrepancyPriority(id: string, priority: string): Promise<void>
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

/**
 * Deadline for the token IPC itself. This is not the same wait as the request:
 * `apiFetch` used to `await desktopToken()` with no bound at all, so a stalled
 * main-process reply hung every /api call forever — and because the promise is
 * memoized, one stall poisoned the whole session with no error and no retry.
 */
export const TOKEN_TIMEOUT_MS = 5_000

async function desktopToken(): Promise<string | undefined> {
  if (typeof window === 'undefined' || !window.__CC_DESKTOP) return undefined
  if (!desktopTokenPromise) {
    const request = window.__CC_DESKTOP.getApiToken()
    // Surfaced through the await below, never as an unhandled rejection when a
    // racing caller has already timed out and walked away from this promise.
    request.catch(() => {})
    desktopTokenPromise = request
  }
  const pending = desktopTokenPromise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const token = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException(`The app did not hand over its API token within ${TOKEN_TIMEOUT_MS / 1000}s.`, 'TimeoutError')),
          TOKEN_TIMEOUT_MS,
        )
      }),
    ])
    // An empty token is a failed handover, not a token. Memoizing it would
    // send every remaining call of the session out unauthenticated — the
    // service 401s each one, and nothing ever asks the main process again.
    if (!token) throw new Error('The app handed over an empty API token.')
    return token
  } catch (error) {
    // Drop the memo so the next call asks again rather than inheriting the stall.
    if (desktopTokenPromise === pending) desktopTokenPromise = null
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  /**
   * The demo bundle is a finished snapshot: nothing indexes, and the generation
   * never moves. Answering honestly (rather than `null`) keeps the console's
   * generation-gated polling on one code path in both modes.
   */
  async status(): Promise<StatusSummary> {
    return {
      generation: 1,
      indexing: false,
      indexingSources: [],
      sources: this.bundle.graph.sources.map((s) => ({
        name: s.name, level: s.level, kind: s.kind, status: s.status === 'ok' ? 'ok' : s.status,
        phase: 'ready', loaded: s.conceptCount, total: s.conceptCount,
        conceptCount: s.conceptCount, refreshing: false, error: s.error ?? null,
      })),
    }
  }
  async conflictResolutions(): Promise<ConflictResolutionRecord[]> { return this.resolutions }
  async discrepancies(): Promise<DiscrepanciesResponse> {
    const conflicts = adaptConflicts(this.bundle.concepts, this.resolutions)
    return {
      discrepancies: conflicts.map((conflict) => legacyConflictRecord(conflict)),
      coverageComplete: true, indexing: false, indexingSources: [], errors: [], generation: 1,
    }
  }
  async decideDiscrepancy(request: DiscrepancyDecisionRequest): Promise<ConflictResolutionRecord> {
    if (request.action !== 'choose_contribution' || !request.selectedSource) {
      const current = (await this.discrepancies()).discrepancies.find((item) => item.id === request.discrepancyId)
      if (!current) throw new LiveDataError('bad-status', 'This discrepancy is no longer open.', 409)
      const chosen = request.action === 'compose'
        ? { layer: current.effectiveSource ?? current.contributions[0].source, content: request.content ?? '', updated: new Date().toISOString() }
        : null
      const record: ConflictResolutionRecord = {
        schemaVersion: 2, id: `demo-${Date.now()}-${this.resolutions.length + 1}`,
        conflictId: current.legacyId ?? current.id, discrepancyId: current.id,
        conceptId: current.conceptId, title: current.conceptTitle, sectionKey: current.key,
        sectionHeading: current.label,
        contributions: current.contributions.map((item) => ({ layer: item.source, level: item.level, content: String(item.value), updated: item.updated })),
        chosen, method: 'manual', actor: 'local-user', decidedAt: new Date().toISOString(),
        action: request.action, reason: request.action === 'acknowledge' ? 'You kept this scoped difference.' : 'You wrote a reconciled answer.',
        reasonCode: request.reasonCode, note: request.note,
        transactionState: request.action === 'acknowledge' ? 'not_required' : 'committed', writtenTargets: [],
      }
      this.resolutions.push(record)
      return record
    }
    const [, conceptId, sectionKey] = request.discrepancyId.split('::')
    return this.resolveConflict({ conceptId, sectionKey, selectedLayer: request.selectedSource, method: 'manual' })
  }
  async discrepancyRules() { return { rules: [], suggestions: [] } }
  async createDiscrepancyRule(): Promise<DiscrepancyRule> { throw new LiveDataError('bad-status', 'Simulation rules reset on reload.', 405) }
  async patchDiscrepancyRule(): Promise<DiscrepancyRule> { throw new LiveDataError('bad-status', 'Automatic rules never run in simulation.', 405) }
  async promoteDiscrepancyRule(): Promise<Record<string, unknown>> { throw new LiveDataError('bad-status', 'Simulation cannot promote team rules.', 405) }
  async setDiscrepancyPriority(): Promise<void> { /* simulation-only local state is owned by the store */ }
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
      // A headingless section still needs a durable label in the decision record.
      sectionHeading: prior?.sectionHeading ?? section!.heading ?? section!.key,
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
  async status(): Promise<StatusSummary | null> {
    try {
      return await this.get<StatusSummary>('/api/status')
    } catch (error) {
      // An engine older than this console has no cheap status route. Say so
      // (null) rather than throwing, so the store falls back to reading
      // progress off the graph instead of showing a permanent failure banner.
      if (error instanceof LiveDataError && error.kind === 'bad-status' && error.status === 404) return null
      throw error
    }
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
  async discrepancies(): Promise<DiscrepanciesResponse | null> {
    try { return await this.get<DiscrepanciesResponse>('/api/discrepancies') }
    catch (error) {
      if (error instanceof LiveDataError && error.kind === 'bad-status' && error.status === 404) return null
      throw error
    }
  }
  async decideDiscrepancy(request: DiscrepancyDecisionRequest): Promise<ConflictResolutionRecord> {
    return (await this.request<{ decision: ConflictResolutionRecord }>('/api/discrepancy-decisions', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(request),
    })).decision
  }
  async discrepancyRules(): Promise<{ rules: DiscrepancyRule[]; suggestions: DiscrepancyRuleSuggestion[] }> {
    return this.get('/api/discrepancy-rules')
  }
  async createDiscrepancyRule(suggestionId: string): Promise<DiscrepancyRule> {
    return (await this.request<{ rule: DiscrepancyRule }>('/api/discrepancy-rules', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ suggestionId }),
    })).rule
  }
  async patchDiscrepancyRule(id: string, changes: { mode?: 'recommend' | 'automatic'; enabled?: boolean }): Promise<DiscrepancyRule> {
    return (await this.request<{ rule: DiscrepancyRule }>(`/api/discrepancy-rules?id=${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes),
    })).rule
  }
  async promoteDiscrepancyRule(id: string, confirm: boolean): Promise<Record<string, unknown>> {
    return this.request('/api/discrepancy-rules/promote', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, confirm }),
    })
  }
  async setDiscrepancyPriority(id: string, priority: string): Promise<void> {
    await this.request(`/api/discrepancies?id=${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priority }),
    })
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

/**
 * `## Choice {#choice}` → `Choice`.
 *
 * Nullable on purpose: a plain note in a `files` layer — an Obsidian daily note
 * with no `#` line — resolves to a single section with `heading: null`. This
 * used to call `.replace` on it and take the whole page down with a TypeError.
 */
function headingText(heading: string | null | undefined): string {
  return (heading ?? '').replace(/^#+\s*/, '').replace(/\s*\{#.*\}\s*$/, '').trim()
}

/** A section always needs *some* name; the engine's key is the honest fallback. */
function sectionName(section: { heading: string | null; key: string }): string {
  return headingText(section.heading) || section.key
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
    sourceLayer: c.layer,
    value: c.content,
    updated: c.updated,
  }))
  return {
    name: sectionName(s),
    key: s.key,
    winner,
    sourceLayer: s.sourceLayer,
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

/** Phase names the engine reports, in the words a person would use for them. */
const PHASE_LABELS: Record<string, string> = {
  queued: 'Queued', scanning: 'Scanning', loading: 'Reading', cloning: 'Cloning',
  ready: 'Ready', error: 'Failed',
}
export function phaseLabel(phase: string | undefined): string {
  return PHASE_LABELS[phase ?? ''] ?? 'Indexing'
}

const NUM = new Intl.NumberFormat()

/**
 * "Reading — 1,240 / 3,000". The counts are the honest thing to show while a
 * source has no concepts yet; a total the engine hasn't established yet reads
 * as a bare count rather than an invented denominator.
 */
export function progressLabel(p: { phase?: string; loaded?: number; total?: number | null } | undefined): string {
  if (!p) return 'Indexing'
  const noTotal = p.total == null || p.total <= 0
  // Walking the tree, nothing counted yet. "Scanning — 0" reads as a stalled
  // count rather than as the phase before counting begins.
  if (noTotal && !p.loaded) return phaseLabel(p.phase)
  const loaded = NUM.format(p.loaded ?? 0)
  return `${phaseLabel(p.phase)} — ${noTotal ? loaded : `${loaded} / ${NUM.format(p.total as number)}`}`
}

/** 0–100, or null when the engine has no denominator to divide by yet. */
export function progressPercent(p: { loaded?: number; total?: number | null } | undefined): number | null {
  if (!p || p.total == null || p.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((p.loaded ?? 0) / p.total) * 100)))
}

/** Graph sources → the console's Source[] (coverage/focus/status derived honestly). */
export function adaptSources(g: GraphSummary): Source[] {
  return g.sources.map((s: GraphSource) => {
    const errored = s.status === 'error'
    // A remote source that can't reach its API doesn't throw — it answers with
    // nothing. The engine marks that 'degraded'; surfacing it as healthy would
    // put a green dot over an outage, which is the one thing this row is for.
    const degraded = s.status === 'degraded'
    // Still being read. This used to fall through to 'synced', so a vault
    // 15 seconds into its first index rendered as "synced · 0 concepts" — the
    // app claiming to be finished with work it had barely started.
    const indexing = s.status === 'indexing'
    const progress = s.indexing
      ? {
          phase: s.indexing.phase,
          loaded: s.indexing.loaded,
          total: s.indexing.total,
          refreshing: s.indexing.refreshing === true,
        }
      : undefined
    const count = `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`
    // An MCP child that died after startup used to keep its green "serving"
    // dot: the adapter answers [] instead of throwing, so a dead server and an
    // empty graph produced the same row. "Serving" now requires evidence —
    // at least one concept actually served and no recorded failure.
    const status = errored
      ? 'error' as const
      : degraded
        ? 'degraded' as const
        : indexing
          ? 'indexing' as const
          : s.kind === 'mcp'
            ? (s.conceptCount > 0 && !s.error ? 'serving' as const : s.error ? 'degraded' as const : 'empty' as const)
            : 'synced' as const
    return {
      name: s.name,
      kind: s.kind === 'mcp' ? 'mcp' : 'okf-local',
      layer: layerOf(s.name, s.level),
      // A source contributing nothing shouldn't show a full bar, however it
      // got there — errored, degraded to empty, or genuinely empty. While it
      // indexes the bar tracks real progress instead of standing in for it.
      coverage: indexing
        ? (progressPercent(progress) ?? 0)
        : errored || s.conceptCount === 0 ? 0 : 100,
      focus: errored
        ? (s.error ?? 'unreachable')
        : indexing
          ? `${progressLabel(progress)} · ${s.kind}`
          : degraded
            ? `${count} · ${s.lastSuccessAt ? `as of ${s.lastSuccessAt} · ` : ''}${s.error ?? 'source unreachable'}`
            : status === 'empty'
              ? `${count} · ${s.kind} — nothing served yet`
              : `${count} · ${s.kind}${progress?.refreshing ? ' · refreshing' : ''}`,
      status,
      ...(progress ? { indexing: progress } : {}),
      // Management fields (Sources view): the raw engine kind plus health
      // timestamps ride along so remove/rename/sync can render honestly.
      sourceKind: s.kind,
      authAlias: s.authAlias ?? null,
      authState: s.authState ?? 'anonymous',
      level: s.level,
      conceptCount: s.conceptCount,
      origin: s.origin ?? null,
      error: s.error ?? null,
      ...(s.quarantined === true ? { quarantined: true } : {}),
      // The true count, which the capped message list is not: a source with 40
      // unreadable files sends 40 here and 10 messages.
      warnings: s.warnings ?? (s.warningMessages?.length ?? 0),
      warningMessages: s.warningMessages ?? [],
      lastSuccessAt: s.lastSuccessAt ?? null,
      lastErrorAt: s.lastErrorAt ?? null,
      ...(s.live === true ? { live: true } : {}),
    }
  })
}

/**
 * Fold a cheap /api/status pass into the source rows the views already hold.
 *
 * Progress rides on /api/graph too, but that route is only refetched when the
 * *content* moves — so without this a Sources row would sit on "Scanning" for
 * the whole of a fifteen-second index while the toolbar counted up beside it.
 * Same numbers, same rules, no extra request.
 *
 * Returns the original array when nothing moved, so an idle poll costs no
 * re-render.
 */
export function mergeSourceStatus(sources: Source[], rows: SourceStatus[]): Source[] {
  if (rows.length === 0) return sources
  const byName = new Map(rows.map((r) => [r.name, r]))
  let changed = false
  const next = sources.map((s) => {
    const row = byName.get(s.name)
    if (!row) return s
    // `=== true` to match adaptSources: the two paths write the same field on
    // the same row, and the identity check below only holds if they normalize
    // a missing flag the same way.
    const progress = { phase: row.phase, loaded: row.loaded, total: row.total, refreshing: row.refreshing === true }
    const indexing = row.status === 'indexing'
    const count = `${row.conceptCount} concept${row.conceptCount === 1 ? '' : 's'}`
    const status: Source['status'] = row.status === 'error'
      ? 'error'
      : row.status === 'degraded'
        ? 'degraded'
        : indexing
          ? 'indexing'
          : s.kind === 'mcp'
            ? (row.conceptCount > 0 && !row.error ? 'serving' : row.error ? 'degraded' : 'empty')
            : 'synced'
    const coverage = indexing
      ? (progressPercent(progress) ?? 0)
      : status === 'error' || row.conceptCount === 0 ? 0 : 100
    // A degraded row's focus carries health detail this route does not have;
    // leave that sentence to the graph rather than flattening it.
    const focus = status === 'error'
      ? (row.error ?? s.focus)
      : indexing
        ? `${progressLabel(progress)} · ${s.sourceKind}`
        : status === 'degraded'
          ? s.focus
          : status === 'empty'
            ? `${count} · ${s.sourceKind} — nothing served yet`
            : `${count} · ${s.sourceKind}${progress.refreshing ? ' · refreshing' : ''}`
    // The error text has to travel with the status it explains. Leaving it
    // behind rendered a row headed "error" with the detail block still hidden,
    // because that block is gated on `error` and this pass only moved `status`.
    const error = row.error ?? null
    // Warnings describe a snapshot. A row with none — first index, or a failed
    // one — has nothing they could be about, so they go rather than hang over
    // from the last good read.
    const hasSnapshot = row.status !== 'indexing' && row.status !== 'error'
    const warnings = hasSnapshot ? s.warnings : 0
    const warningMessages = hasSnapshot ? s.warningMessages : undefined
    const same = s.status === status && s.conceptCount === row.conceptCount
      && s.coverage === coverage && s.focus === focus
      && (s.error ?? null) === error
      && s.warnings === warnings && s.warningMessages === warningMessages
      && s.indexing?.phase === progress.phase && s.indexing?.loaded === progress.loaded
      && s.indexing?.total === progress.total && s.indexing?.refreshing === progress.refreshing
    if (same) return s
    changed = true
    // lastErrorAt/lastSuccessAt are deliberately untouched: /api/status carries
    // no health timestamps, and inventing one here would be a worse lie than a
    // stale one. A status flip moves the engine's generation, so the next
    // /api/graph fills them in.
    return { ...s, status, conceptCount: row.conceptCount, coverage, focus, error, warnings, warningMessages, indexing: progress }
  })
  return changed ? next : sources
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
        section: sectionName(s),
        title: `${sectionName(s)} — ${title}`,
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
      winner: layerOf(latest.chosen?.layer ?? latest.contributions[0]?.layer ?? '', latest.chosen?.level ?? latest.contributions[0]?.level ?? 0),
      contributions,
      safe: false,
      history,
    })
  }
  return out
}

function legacyConflictRecord(conflict: Conflict): DiscrepancyRecord {
  return {
    id: `section_content::${conflict.concept}::${conflict.sectionKey}`,
    legacyId: conflict.id,
    kind: 'section_content', originalKind: 'section_content',
    conceptId: conflict.concept, conceptTitle: conflict.title, conceptType: 'concept',
    key: conflict.sectionKey, label: conflict.section,
    revision: `${conflict.id}:${conflict.history.length}`,
    status: conflict.status === 'resolved' ? 'resolved' : 'needs_review',
    contributions: conflict.contributions.map((item, index) => ({
      source: item.sourceLayer, level: item.layer === 'personal' ? 3 : item.layer === 'team' ? 2 : 0,
      updated: item.updated || null, value: item.value, fingerprint: `${conflict.id}:${index}`, effective: index === 0,
    })),
    effectiveSource: conflict.contributions[0]?.sourceLayer ?? null,
    effectiveValue: conflict.contributions[0]?.value ?? '',
    winnerReason: `${conflict.contributions[0]?.sourceLayer ?? 'The selected source'} wins by configured layer precedence.`,
    owner: 'Unassigned', priority: 'unassigned', fresherDissent: conflict.contributions.some((item) => item.fresherDissent),
    freshness: { effectiveUpdated: conflict.contributions[0]?.updated ?? null, newestUpdated: conflict.contributions[0]?.updated ?? null, hasNewerDissent: conflict.contributions.some((item) => item.fresherDissent) },
    affectedLinks: [],
    sourceHealth: conflict.contributions.map((item) => ({ source: item.sourceLayer, status: 'ok', error: null })),
    history: conflict.history, matchingRules: [],
  }
}

/** Raw professional discrepancy records → the existing navigator view model. */
export function adaptDiscrepancies(records: DiscrepancyRecord[], coverageComplete = true): Conflict[] {
  return records.map((record) => {
    const contributions = record.contributions.map((item) => ({
      layer: layerOf(item.source, item.level), sourceLayer: item.source,
      value: typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2),
      updated: item.updated ?? '',
      ...(record.fresherDissent && !item.effective ? { fresherDissent: true } : {}),
    }))
    const effective = record.contributions.find((item) => item.effective) ?? record.contributions[0]
    return {
      id: record.id, concept: record.conceptId, sectionKey: record.key,
      section: record.label, title: `${record.label} — ${record.conceptTitle}`,
      status: record.status === 'resolved' ? 'resolved' : 'open',
      winner: layerOf(effective?.source ?? '', effective?.level ?? 0),
      contributions, safe: false, history: record.history,
      kind: record.kind, discrepancyStatus: record.status, revision: record.revision,
      owner: record.owner, priority: record.priority, winnerReason: record.winnerReason,
      effectiveSource: record.effectiveSource, coverageComplete, sourceHealth: record.sourceHealth,
      matchingRules: record.matchingRules, ruleConflict: record.ruleConflict, target: record.target,
      affectedLinks: record.affectedLinks,
    }
  })
}
