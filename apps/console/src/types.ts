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
  schemaVersion: 1
  id: string
  conflictId: string
  conceptId: string
  title: string
  sectionKey: string
  sectionHeading: string
  contributions: ConflictResolutionContribution[]
  chosen: ConflictResolutionContribution
  method: 'automatic' | 'manual'
  reason: string
  actor: 'local-user'
  decidedAt: string
  supersedes?: string
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
