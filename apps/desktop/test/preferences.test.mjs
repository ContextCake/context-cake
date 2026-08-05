import assert from 'node:assert/strict'
import test from 'node:test'
import { changedPreferencePatch, validatePreferencePatch } from '../src/main/preferences.mjs'

test('preference patches accept only fixed-purpose writable values', () => {
  assert.deepEqual(validatePreferencePatch({ theme: 'system', density: 'compact', updateCheck: false, anonymousMetrics: true }), {
    theme: 'system', density: 'compact', updateCheck: false, anonymousMetrics: true,
  })
  assert.throws(() => validatePreferencePatch({ reducedTransparency: false }), /unsupported field/)
  assert.throws(() => validatePreferencePatch({ theme: 'automatic' }), /Invalid theme/)
  assert.throws(() => validatePreferencePatch({ density: 'dense' }), /Invalid density/)
  assert.throws(() => validatePreferencePatch({ updateCheck: 'yes' }), /Invalid update/)
  assert.throws(() => validatePreferencePatch({ anonymousMetrics: null }), /Invalid metrics/)
})

test('no-op preference changes produce no persistence patch', () => {
  const current = { theme: 'system', density: 'comfortable', updateCheck: true, anonymousMetrics: null }
  assert.deepEqual(changedPreferencePatch(current, { theme: 'system', density: 'comfortable' }), {})
  assert.deepEqual(changedPreferencePatch(current, { density: 'compact' }), { density: 'compact' })
})
