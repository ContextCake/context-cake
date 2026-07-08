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
  heading: string
  content: string
  sourceLayer: string
  sourceUpdated: string | null
  /** A higher layer blanked this inherited section (override=none). Skip its content; show as audit row. */
  suppressed?: boolean
  /** Losing contributors for this section — surfaced, never hidden. */
  conflicts?: SectionConflict[]
}

/** One effective OKF concept stitched across layers. */
export interface ResolvedConcept {
  id: string
  contributors: Contributor[]
  frontmatter: Record<string, unknown>
  frontmatterProvenance?: Record<string, string>
  sections: ResolvedSection[]
}

/** A source (layer) row in the graph summary. */
export interface GraphSource {
  name: string
  level: number
  kind: string // 'okf-local' | 'mcp'
  location?: string
  origin?: string | null
  conceptCount: number
  tokens: number
  latestUpdated: string | null
  status: string // 'ok' | 'error'
  error: string | null
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
  totals: { sourceTokens: number; resolvedTokens: number; concepts: number; sources: number }
  sources: GraphSource[]
  concepts: GraphConcept[]
}

/** The shape build-demo-data.mjs emits and DemoSource imports. */
export interface DemoBundle {
  graph: GraphSummary
  concepts: ResolvedConcept[]
}
