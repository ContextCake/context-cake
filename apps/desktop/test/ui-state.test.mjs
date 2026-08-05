import assert from 'node:assert/strict'
import test from 'node:test'
import { applyUiStatePatch, normalizeUiState } from '../src/main/ui-state.mjs'

test('UI state defaults, validates routes, and clamps legacy sidebar widths', () => {
  assert.deepEqual(normalizeUiState({ sidebar: { collapsed: true, width: 999 }, lastView: 'obsolete' }), {
    sidebar: { collapsed: true, width: 300 }, lastView: 'overview', knowledgeView: 'concepts', reviewView: 'triage', settingsPane: 'general',
  })
  assert.equal(applyUiStatePatch(normalizeUiState(), { sidebar: { width: 100 } }).state.sidebar.width, 208)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { token: 'nope' }), /unsupported/)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { lastView: 'obsolete' }), /Invalid last view/)
})

test('UI state patches report no-op writes and retain sibling fields', () => {
  const current = normalizeUiState({ sidebar: { collapsed: false, width: 232 }, lastView: 'files' })
  assert.equal(applyUiStatePatch(current, { lastView: 'files' }).changed, false)
  const next = applyUiStatePatch(current, { sidebar: { collapsed: true } })
  assert.equal(next.changed, true)
  assert.deepEqual(next.state.sidebar, { collapsed: true, width: 232 })
})
