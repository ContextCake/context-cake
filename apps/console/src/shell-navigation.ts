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

export function parseHash(hash: string): { view?: ViewId; concept?: string } {
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
  return { view: candidate }
}

export function dispatchNavigationGuard(): boolean {
  return window.dispatchEvent(new Event('contextcake:before-navigate', { cancelable: true }))
}

export const SEARCHABLE_VIEWS = new Set<ViewId>(['concepts', 'files', 'sources', 'triage', 'conflicts'])

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
