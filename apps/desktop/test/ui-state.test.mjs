import assert from 'node:assert/strict'
import test from 'node:test'
import { applyUiStatePatch, normalizeUiState } from '../src/main/ui-state.mjs'

test('UI state defaults, validates routes, and clamps legacy sidebar widths', () => {
  assert.deepEqual(normalizeUiState({ sidebar: { collapsed: true, width: 999 }, lastView: 'obsolete' }), {
    sidebar: { collapsed: true, width: 300 }, lastView: 'overview', knowledgeView: 'concepts', reviewView: 'triage', settingsPane: 'general',
    cascadeDisplay: 'grouped', cascadeHiddenNodes: [],
  })
  assert.equal(applyUiStatePatch(normalizeUiState(), { sidebar: { width: 100 } }).state.sidebar.width, 208)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { token: 'nope' }), /unsupported/)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { lastView: 'obsolete' }), /Invalid last view/)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { cascadeDisplay: 'wall' }), /Invalid Cascade display/)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { cascadeHiddenNodes: ['folder:invalid:notes'] }), /Invalid hidden Cascade/)
  const oversized = Array.from({ length: 1_000 }, (_, index) => `concept:${index}-${'x'.repeat(1_900)}`)
  assert.throws(() => applyUiStatePatch(normalizeUiState(), { cascadeHiddenNodes: oversized }), /Invalid hidden Cascade/)
})

test('UI state patches report no-op writes and retain sibling fields', () => {
  const current = normalizeUiState({ sidebar: { collapsed: false, width: 232 }, lastView: 'files' })
  assert.equal(applyUiStatePatch(current, { lastView: 'files' }).changed, false)
  const next = applyUiStatePatch(current, { sidebar: { collapsed: true } })
  assert.equal(next.changed, true)
  assert.deepEqual(next.state.sidebar, { collapsed: true, width: 232 })
})

test('Cascade view and valid hidden targets survive normalization as device-local UI state', () => {
  const current = normalizeUiState({
    cascadeDisplay: 'cards',
    cascadeHiddenNodes: ['concept:identity', 'folder:personal:journal', 'folder:company:%'],
  })
  assert.equal(current.cascadeDisplay, 'cards')
  assert.deepEqual(current.cascadeHiddenNodes, ['concept:identity', 'folder:personal:journal'])

  const next = applyUiStatePatch(current, {
    cascadeDisplay: 'compact',
    cascadeHiddenNodes: ['concept:identity', 'folder:team:"run\u2028books"'],
  })
  assert.equal(next.changed, true)
  assert.equal(next.state.cascadeDisplay, 'compact')
  assert.deepEqual(next.state.cascadeHiddenNodes, ['concept:identity', 'folder:team:"run\u2028books"'])
})
