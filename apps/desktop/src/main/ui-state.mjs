import { isDeepStrictEqual } from 'node:util'

const VIEWS = new Set(['canvas', 'overview', 'sources', 'triage', 'conflicts', 'concepts', 'files'])
const KNOWLEDGE_VIEWS = new Set(['concepts', 'files'])
const REVIEW_VIEWS = new Set(['triage', 'conflicts'])
const SETTINGS_PANES = new Set(['general', 'indexing', 'integrations', 'account', 'privacy'])

export const DEFAULT_UI_STATE = Object.freeze({
  sidebar: { collapsed: false, width: 232 },
  lastView: 'overview',
  knowledgeView: 'concepts',
  reviewView: 'triage',
  settingsPane: 'general',
})

const clampSidebarWidth = (value) => Math.min(300, Math.max(208, value))

export function normalizeUiState(candidate) {
  const value = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const sidebar = value.sidebar && typeof value.sidebar === 'object' && !Array.isArray(value.sidebar) ? value.sidebar : {}
  return {
    sidebar: {
      collapsed: sidebar.collapsed === true,
      width: Number.isFinite(sidebar.width) ? clampSidebarWidth(sidebar.width) : DEFAULT_UI_STATE.sidebar.width,
    },
    lastView: VIEWS.has(value.lastView) ? value.lastView : DEFAULT_UI_STATE.lastView,
    knowledgeView: KNOWLEDGE_VIEWS.has(value.knowledgeView) ? value.knowledgeView : DEFAULT_UI_STATE.knowledgeView,
    reviewView: REVIEW_VIEWS.has(value.reviewView) ? value.reviewView : DEFAULT_UI_STATE.reviewView,
    settingsPane: SETTINGS_PANES.has(value.settingsPane) ? value.settingsPane : DEFAULT_UI_STATE.settingsPane,
  }
}

export function applyUiStatePatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('UI state patch must be an object.')
  const allowed = new Set(['sidebar', 'lastView', 'knowledgeView', 'reviewView', 'settingsPane'])
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('UI state patch contains an unsupported field.')
  if (patch.sidebar !== undefined) {
    if (!patch.sidebar || typeof patch.sidebar !== 'object' || Array.isArray(patch.sidebar)) throw new Error('Invalid sidebar state.')
    for (const key of Object.keys(patch.sidebar)) if (key !== 'collapsed' && key !== 'width') throw new Error('Invalid sidebar state field.')
    if (patch.sidebar.collapsed !== undefined && typeof patch.sidebar.collapsed !== 'boolean') throw new Error('Invalid sidebar collapsed state.')
    if (patch.sidebar.width !== undefined && !Number.isFinite(patch.sidebar.width)) throw new Error('Invalid sidebar width.')
  }
  if (patch.lastView !== undefined && !VIEWS.has(patch.lastView)) throw new Error('Invalid last view.')
  if (patch.knowledgeView !== undefined && !KNOWLEDGE_VIEWS.has(patch.knowledgeView)) throw new Error('Invalid knowledge view.')
  if (patch.reviewView !== undefined && !REVIEW_VIEWS.has(patch.reviewView)) throw new Error('Invalid review view.')
  if (patch.settingsPane !== undefined && !SETTINGS_PANES.has(patch.settingsPane)) throw new Error('Invalid Settings pane.')

  const normalized = normalizeUiState({
    ...current,
    ...patch,
    sidebar: patch.sidebar ? { ...current?.sidebar, ...patch.sidebar } : current?.sidebar,
  })
  return { state: normalized, changed: !isDeepStrictEqual(normalizeUiState(current), normalized) }
}
