// The engine contract — the exact JSON shapes ContextCake's resolver and the
// playground server emit. These are the RAW wire types; the console's view
// model (Concept, Source, Conflict in data.ts) is derived from them by the
// adapters in api.ts. Mirror the engine, never invent fields:
//   - ResolvedConcept  ← `node resolver.mjs --concept <id>` / GET /api/resolve
//   - GraphSummary     ← GET /api/graph  (playground server.mjs buildGraph)
// See specs/contextcake-core/design.md §4 and site design.md §11.3.

/** One contributing layer to a resolved concept, in precedence order (winner first). */
export interface Contributor {
  layer: string
  level: number
  updated: string | null
}

/** A dissenting layer's value retained on a conflicted section. */
export interface SectionConflict {
  layer: string
  updated: string | null
  content: string
}

/** One resolved section: the winning value plus provenance and any dissent. */
export interface ResolvedSection {
  key: string
  /** Null for a document with no heading at all — a plain note in a files layer. */
  heading: string | null
  content: string
  sourceLayer: string
  sourceUpdated: string | null
  /** A higher layer blanked this inherited section (override=none). Skip its content; show as audit row. */
  suppressed?: boolean
  /** Losing contributors for this section — surfaced, never hidden. */
  conflicts?: SectionConflict[]
  /**
   * True only when the winner's `sourceUpdated` and at least one dissent's
   * `updated` both parse and that dissent is strictly newer at day
   * granularity. Absent otherwise — never treat missing dates as epoch 0.
   */
  fresherDissent?: boolean
}

/** One effective OKF concept stitched across layers. */
export interface ResolvedConcept {
  id: string
  contributors: Contributor[]
  frontmatter: Record<string, unknown>
  frontmatterProvenance?: Record<string, string>
  sections: ResolvedSection[]
}

/** Background-index progress for one source. */
export interface IndexProgress {
  status: 'indexing' | 'ready' | 'error'
  /** 'queued' | 'scanning' | 'loading' | 'ready' | 'error' */
  phase: string
  loaded: number
  total: number | null
  elapsedMs: number
  /** Serving a good snapshot AND re-reading behind it — never a blocking wait. */
  refreshing?: boolean
  /** Passes this entry has run, carried across refreshes — a re-index storm is visible here. */
  passes?: number
}

/** One source row from GET /api/status — progress and health, no concepts. */
export interface SourceStatus {
  name: string
  level: number
  kind: string
  /** 'ok' | 'indexing' | 'degraded' | 'error' — the same four /api/graph reports. */
  status: string
  /** 'queued' | 'scanning' | 'loading' | 'ready' | 'error' */
  phase: string
  loaded: number
  total: number | null
  conceptCount: number
  /** Ready and re-reading behind a good snapshot. Distinct from `status: indexing`. */
  refreshing: boolean
  error: string | null
  /** An invalid manifest entry rather than a source — same meaning as GraphSource's. */
  quarantined?: boolean
}

/**
 * GET /api/status — the cheap route (O(sources), sub-millisecond even on a
 * large vault). `generation` moves whenever the /api/graph payload would
 * differ, which is what lets a client poll here and refetch the heavy payloads
 * only when they actually changed.
 */
export interface StatusSummary {
  generation: number
  indexing: boolean
  indexingSources: string[]
  sources: SourceStatus[]
}

/**
 * One hit from GET /api/search — BM25F over stemmed section content
 * (`searchConcepts` in packages/core/src/search.mjs). `layers` names every
 * contributing layer, best-scoring first; `snippet` is pre-extracted around
 * the matched terms, so the console never has to re-tokenize the body.
 * Hits arrive pre-sorted by score, highest first.
 */
export interface SearchHit {
  id: string
  title: string | null
  score: number
  layers: string[]
  snippet: string
}

/** A source (layer) row in the graph summary. */
export interface GraphSource {
  name: string
  level: number
  kind: string // 'okf-local' | 'files' | 'mcp'
  /** Credential reference metadata only; the engine never returns the secret. */
  authAlias?: string | null
  authState?: 'ok' | 'anonymous' | 'missing-token' | 'host-mismatch'
  location?: string
  origin?: string | null
  conceptCount: number
  tokens: number
  latestUpdated: string | null
  /**
   * 'ok' | 'indexing' | 'degraded' | 'error'. 'indexing' is a source the
   * background index has not finished reading yet. 'degraded' is a source that
   * listed but whose adapter reports its last request failed — it is serving
   * cached or partial content and still resolves, unlike 'error', which
   * contributed nothing.
   */
  status: string
  error: string | null
  /**
   * This row is a manifest entry that failed validation, not a source that
   * failed to read: nothing was built for it, so there is nothing to retry,
   * rename or sync. Removing the entry is the only action that helps.
   */
  quarantined?: boolean
  /**
   * Things this source could not read even though it indexed successfully — a
   * document over the per-file size cap, a subfolder it lacks permission to
   * open. Orthogonal to `status`: the source is serving, just not everything it
   * was pointed at. `warnings` is the true count; `warningMessages` is capped.
   */
  warnings?: number
  warningMessages?: string[]
  /** Background-index progress; absent on sources that never index. */
  indexing?: IndexProgress
  /** ISO timestamps from adapters that track health (remote sources); else null. */
  lastErrorAt?: string | null
  lastSuccessAt?: string | null
  /** The manifest's team-capture layer (`live: true`); absent until the engine exposes it. */
  live?: boolean
}

/** A concept index entry in the graph summary (lighter than a full resolve). */
export interface GraphConcept {
  id: string
  type: string
  title: string
  contributors: string[] // layer names, winner first
  winner: string | null
  conflictCount: number
  tokens: number
}

/** Everything the canvas/overview need in one shot — GET /api/graph. */
export interface GraphSummary {
  manifest?: { path: string }
  tokenizer?: string
  /** True while any source is still being read; the payload is partial. */
  indexing?: boolean
  indexingSources?: string[]
  /** The same counter GET /api/status reports — absent on an older engine. */
  generation?: number
  totals: { sourceTokens: number; resolvedTokens: number; concepts: number; sources: number }
  sources: GraphSource[]
  concepts: GraphConcept[]
}

/** One configurable engine setting — GET /api/settings `catalog`. */
export interface SettingDef {
  key: string
  label: string
  help: string
  min: number
  max: number
  default: number
}

/** GET /api/settings. `settings` is effective, `stored` is what the manifest holds. */
export interface SettingsPayload {
  settings: Record<string, number>
  stored: Record<string, number>
  catalog: SettingDef[]
}

/** A file inside a layer — GET /api/files. */
export interface LayerFile {
  path: string
  name: string
  rel: string
  ext: string
  kind: string // 'text' | 'image' | 'svg' | 'pdf' | 'binary'
  markdown: boolean
}

export interface LayerFiles {
  layer: string
  kind: string
  root: string
  fileCount: number
  truncated: boolean
  files: LayerFile[]
}

/** GET /api/file — one file's content and metadata. */
export interface FileContent {
  path: string
  layer: string
  rel: string
  ext: string
  kind: string
  editable: boolean
  markdown: boolean
  bytes: number
  modified: string
  text?: string
  reason?: string
}

export interface ConflictResolutionContribution {
  layer: string
  /** Source precedence retained so custom layer names keep the right visual scope. */
  level?: number
  content: string
  updated: string | null
}

/** One append-only decision returned by GET /api/conflict-resolutions. */
export interface ConflictResolutionRecord {
  schemaVersion: 1 | 2
  id: string
  conflictId: string
  conceptId: string
  title: string
  sectionKey: string
  sectionHeading: string
  contributions: ConflictResolutionContribution[]
  chosen: ConflictResolutionContribution | null
  method: 'automatic' | 'manual'
  reason: string
  actor: 'local-user'
  decidedAt: string
  supersedes?: string
  discrepancyId?: string
  discrepancyKind?: DiscrepancyKind
  revision?: string
  action?: DiscrepancyAction
  reasonCode?: AcknowledgementReason
  note?: string
  ruleId?: string
  transactionId?: string
  transactionState?: 'committed' | 'rolled_back' | 'recovery_required' | 'not_required' | 'blocked'
  writtenTargets?: { layer: string; path: string }[]
  contributorFingerprints?: { source: string; fingerprint: string }[]
  supersededDecisionId?: string
}

export type DiscrepancyKind = 'section_content' | 'frontmatter_value' | 'broken_link' | 'changed_after_decision'
export type DiscrepancyStatus = 'needs_review' | 'recommended' | 'auto_ready' | 'acknowledged' | 'resolved' | 'reopened' | 'blocked'
/**
 * `choose_contribution` / `compose` / `acknowledge` are the original three.
 * `rewrite_link` / `unlink` / `create_stub` are the broken-link fix actions
 * (POST /api/discrepancy-decisions on the same route): the engine 409s
 * choose/compose against a broken link and 400s the link actions against
 * every other kind, so the UI offers each set only where it applies.
 */
export type DiscrepancyAction = 'choose_contribution' | 'compose' | 'acknowledge' | 'rewrite_link' | 'unlink' | 'create_stub'
export type AcknowledgementReason = 'different_scopes' | 'temporary_migration' | 'source_specific_authority' | 'target_missing' | 'other'

export interface DiscrepancyContribution {
  source: string
  level: number
  updated: string | null
  value: unknown
  fingerprint: string
  effective: boolean
  /**
   * Compact rows (`?fields=compact`) preview `value` to ≤240 chars and say so
   * here. Absent on a full record — which is how an engine too old to serve
   * compact rows is told apart from one that does (`compactDiscrepancy` in
   * packages/core/src/discrepancies.mjs).
   */
  truncated?: boolean
  valueBytes?: number
  valueKind?: 'string' | 'list' | 'map'
}

/**
 * How the engine matched a broken link's target to an existing concept id —
 * structural rules only (see Appendix B of the plan), never model-inferred.
 */
export type LinkCandidateReason = 'relative' | 'case' | 'extension' | 'slug' | 'moved' | 'title' | 'slug_moved' | 'typo'

export interface LinkCandidate {
  id: string
  reason: LinkCandidateReason | string
  confidence: number
}

export interface DiscrepancyRule {
  id: string
  scope: 'local' | 'team'
  mode: 'recommend' | 'automatic'
  enabled: boolean
  /** `conceptType` and `key` may be the literal `"*"` (any); `target` is always exact. */
  match: { kind: DiscrepancyKind; conceptType: string; key: string; sources: string[]; target?: string }
  action: { type: 'prefer_source'; source: string } | { type: 'acknowledge'; reasonCode: AcknowledgementReason } | { type: 'rewrite_link'; newTarget: string }
  evidenceDecisionIds: string[]
}

export interface DiscrepancyRuleSuggestion {
  id: string
  match: DiscrepancyRule['match']
  action: DiscrepancyRule['action']
  evidenceDecisionIds: string[]
  evidenceCount: number
  /** A `*` suggestion mined from evidence spanning several (conceptType, key) pairs. */
  generalized?: boolean
}

/** The compact row's stand-in for `history[]`: how many, and the latest. */
export interface DiscrepancyLatestDecision {
  id: string
  action: DiscrepancyAction | null
  decidedAt: string | null
  transactionState: ConflictResolutionRecord['transactionState'] | null
  reasonCode?: AcknowledgementReason
}

export interface DiscrepancyRecord {
  id: string
  legacyId?: string
  kind: DiscrepancyKind
  originalKind: DiscrepancyKind
  conceptId: string
  conceptTitle: string
  conceptType: string
  key: string
  label: string
  target?: string
  revision: string
  status: DiscrepancyStatus
  contributions: DiscrepancyContribution[]
  effectiveSource: string | null
  effectiveValue: unknown
  winnerReason: string
  owner: string
  priority: string
  fresherDissent: boolean
  freshness: { effectiveUpdated: string | null; newestUpdated: string | null; hasNewerDissent: boolean }
  affectedLinks: string[]
  sourceHealth: ({ source: string; status: string; error: string | null } | null)[]
  /** Absent on a compact row — `historyCount` + `latestDecision` stand in until `?id=` fetches the full record. */
  history?: ConflictResolutionRecord[]
  matchingRules: Pick<DiscrepancyRule, 'id' | 'scope' | 'mode' | 'action' | 'evidenceDecisionIds'>[]
  ruleConflict?: boolean
  /** Broken links only: ≤5 structural near-matches for `target`, best first. */
  candidates?: LinkCandidate[]
  /** The candidate confident enough (≥0.85, unambiguous) to be a one-click fix, else null. */
  bestCandidate?: LinkCandidate | null
  historyCount?: number
  latestDecision?: DiscrepancyLatestDecision | null
  /** Set by the engine on every `?fields=compact` row. */
  compact?: boolean
}

/** Counts and groupings over the whole projection — GET /api/discrepancies?fields=compact and /api/discrepancies/summary. */
export interface DiscrepancySummary {
  total: number
  actionable: number
  byKind: Record<DiscrepancyKind, number>
  byStatus: Record<DiscrepancyStatus, number>
  bySourcePair: { key: string; sources: string[]; count: number; actionable: number }[]
  byOwner: { owner: string; count: number; actionable: number }[]
  byConceptType: { conceptType: string; count: number; actionable: number }[]
  /** `bestCandidate` is the one every record for that target agrees on, else null. */
  topTargets: { target: string; count: number; actionable: number; bestCandidate: LinkCandidate | null }[]
  topConcepts: { conceptId: string; conceptTitle: string; count: number; actionable: number }[]
  quickWins: { autoReady: number; recommended: number; brokenLinksWithBestCandidate: number; brokenLinksTotal: number }
}

export interface DiscrepanciesResponse {
  discrepancies: DiscrepancyRecord[]
  coverageComplete: boolean
  indexing: boolean
  indexingSources: string[]
  errors: { concept: string; error: string }[]
  generation: number
  /** Present only in the extended envelope (any of `fields`/filter/paging params); a bare GET stays the old shape. */
  summary?: DiscrepancySummary
  total?: number
  filtered?: number
  offset?: number
  limit?: number | null
  projectionRevision?: string
}

/** GET /api/discrepancies?id=<id> — one full record, or null when it is not open. */
export interface DiscrepancyDetailResponse {
  discrepancy: DiscrepancyRecord | null
  generation: number
  projectionRevision?: string
}

export interface DiscrepancyDecisionRequest {
  discrepancyId: string
  revision: string
  action: DiscrepancyAction
  selectedSource?: string
  content?: string
  reasonCode?: AcknowledgementReason
  note?: string
  /** `rewrite_link`: the concept id the link should point at instead. */
  newTarget?: string
  /** `create_stub`: the writable layer that receives the new concept file. */
  layer?: string
  title?: string
  type?: string
}

/** POST /api/discrepancy-decisions/batch. ≤500 decisions; `dryRun` runs every pre-check and writes nothing. */
export interface DiscrepancyBatchRequest {
  decisions: DiscrepancyDecisionRequest[]
  stopOnError?: boolean
  dryRun?: boolean
}

export interface DiscrepancyBatchResult {
  discrepancyId: string
  ok: boolean
  status?: number
  code?: string
  error?: string
  decision?: ConflictResolutionRecord
  written?: { layer: string; path: string }[]
  /** Dry run only: the files a real run would change. */
  wouldWrite?: { layer: string; path: string }[]
}

export interface DiscrepancyBatchResponse {
  ok: boolean
  applied: number
  failed: number
  results: DiscrepancyBatchResult[]
  git?: { layer: string; commits?: number; pushed?: boolean; queued?: boolean; error?: string }
  suggestions?: DiscrepancyRuleSuggestion[]
  /**
   * Console-side only: the engine had no batch route (404) and the adapter
   * ran the decisions one at a time. A dry run against such an engine could
   * check nothing, so `results` then carry no `wouldWrite`.
   */
  fallback?: 'sequential'
}

export interface ResolveConflictRequest {
  conceptId: string
  sectionKey: string
  selectedLayer: string
  method: 'automatic' | 'manual'
  resolutionId?: string
}

/** The shape build-demo-data.mjs emits and DemoSource imports. */
export interface DemoBundle {
  graph: GraphSummary
  concepts: ResolvedConcept[]
}

/**
 * The file half of the demo bundle: one `/api/files` listing plus the
 * `/api/file` answer for every path in it, both from the engine's own file APIs
 * (build-demo-data.mjs). Read-only by construction — there is no write route to
 * snapshot, so the demo has nothing to fake.
 */
export interface DemoFiles {
  layers: LayerFiles[]
  files: Record<string, FileContent>
}
