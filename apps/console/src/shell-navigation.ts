export type ViewId = 'canvas' | 'overview' | 'sources' | 'triage' | 'conflicts' | 'concepts' | 'files'
export type ShellDestination = 'home' | 'cascade' | 'knowledge' | 'sources' | 'review'
export type KnowledgeSubview = 'concepts' | 'files'
export type ReviewSubview = 'triage' | 'conflicts'

export const VIEW_IDS: readonly ViewId[] = ['canvas', 'overview', 'sources', 'triage', 'conflicts', 'concepts', 'files']

export const DESTINATION_VIEWS: Record<ShellDestination, readonly ViewId[]> = {
  home: ['overview'],
  cascade: ['canvas'],
  knowledge: ['concepts', 'files'],
  sources: ['sources'],
  review: ['triage', 'conflicts'],
}

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && VIEW_IDS.includes(value as ViewId)
}

export function destinationForView(view: ViewId): ShellDestination {
  if (view === 'overview') return 'home'
  if (view === 'canvas') return 'cascade'
  if (view === 'concepts' || view === 'files') return 'knowledge'
  if (view === 'sources') return 'sources'
  return 'review'
}

export function viewForDestination(
  destination: ShellDestination,
  knowledgeView: KnowledgeSubview = 'concepts',
  reviewView: ReviewSubview = 'triage',
): ViewId {
  if (destination === 'home') return 'overview'
  if (destination === 'cascade') return 'canvas'
  if (destination === 'knowledge') return knowledgeView
  if (destination === 'sources') return 'sources'
  return reviewView
}

/**
 * What a location hash says. `layer`/`file` belong to the Files route:
 * `layer` is the source the navigator is scoped to and `file` is the engine's
 * own `<layer>/<rel>` path — the same string `/api/file?path=` takes, so a
 * deep link needs no translation on either side.
 */
export interface ParsedHash {
  view?: ViewId
  concept?: string
  layer?: string
  file?: string
}

export function parseHash(hash: string): ParsedHash {
  const value = hash.replace(/^#\/?/, '')
  if (!value) return {}
  const slash = value.indexOf('/')
  const candidate = slash === -1 ? value : value.slice(0, slash)
  if (!isViewId(candidate)) return {}
  const rest = slash === -1 ? '' : value.slice(slash + 1)
  if (candidate === 'concepts' && rest) {
    try { return { view: candidate, concept: decodeURIComponent(rest) } }
    catch { return { view: candidate } }
  }
  if (candidate === 'files' && rest) {
    // Two segments, each percent-encoded on its own, so a layer name with a
    // space and a note nested six folders deep both survive the round trip.
    const cut = rest.indexOf('/')
    try {
      const layer = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut))
      if (!layer) return { view: candidate }
      const rel = cut === -1 ? '' : decodeURIComponent(rest.slice(cut + 1))
      return rel ? { view: candidate, layer, file: `${layer}/${rel}` } : { view: candidate, layer }
    } catch { return { view: candidate } }
  }
  return { view: candidate }
}

/**
 * The Files route as a hash. The scope is the addressable part: a file is
 * carried only while the navigator is scoped to the layer that holds it, so
 * `parseHash(filesHash(scope, file))` restores exactly the state it left.
 * Unscoped browsing is `#/files` — a stable URL, not an alias for whichever
 * file happened to be open (the same bare/deep split Concepts already makes).
 */
export function filesHash(layer: string | null, file?: string | null): string {
  if (!layer) return '#/files'
  const prefix = `${layer}/`
  const rel = file && file.startsWith(prefix) ? file.slice(prefix.length) : ''
  return rel
    ? `#/files/${encodeURIComponent(layer)}/${encodeURIComponent(rel)}`
    : `#/files/${encodeURIComponent(layer)}`
}

export function dispatchNavigationGuard(): boolean {
  return window.dispatchEvent(new Event('contextcake:before-navigate', { cancelable: true }))
}

export const SEARCHABLE_VIEWS = new Set<ViewId>(['concepts', 'files', 'sources', 'triage', 'conflicts'])

/** Per-view document title, same names the command palette's "Go to …" entries use. */
export const VIEW_TITLES: Record<ViewId, string> = {
  overview: 'Home',
  canvas: 'Cascade',
  concepts: 'Knowledge: Concepts',
  files: 'Knowledge: Files',
  sources: 'Sources',
  triage: 'Review: Queue',
  conflicts: 'Review: Discrepancies',
}

export function titleForView(view: ViewId): string {
  return `${VIEW_TITLES[view]} — ContextCake`
}

export function readBrowserGroupedViews(): { knowledgeView: KnowledgeSubview; reviewView: ReviewSubview } {
  try {
    return {
      knowledgeView: localStorage.getItem('contextcake.knowledgeView') === 'files' ? 'files' : 'concepts',
      reviewView: localStorage.getItem('contextcake.reviewView') === 'conflicts' ? 'conflicts' : 'triage',
    }
  } catch {
    return { knowledgeView: 'concepts', reviewView: 'triage' }
  }
}
