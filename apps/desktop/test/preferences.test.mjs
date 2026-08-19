import assert from 'node:assert/strict'
import test from 'node:test'
import { changedPreferencePatch, validatePreferencePatch } from '../src/main/preferences.mjs'

test('preference patches accept only fixed-purpose writable values', () => {
  assert.deepEqual(validatePreferencePatch({ theme: 'system', density: 'compact', updateCheck: false, anonymousMetrics: true }), {
    theme: 'system', density: 'compact', updateCheck: false, anonymousMetrics: true,
  })
  assert.throws(() => validatePreferencePatch({ highContrast: true }), /unsupported field/)
  assert.throws(() => validatePreferencePatch({ theme: 'automatic' }), /Invalid theme/)
  assert.throws(() => validatePreferencePatch({ density: 'dense' }), /Invalid density/)
  assert.throws(() => validatePreferencePatch({ updateCheck: 'yes' }), /Invalid update/)
  assert.throws(() => validatePreferencePatch({ anonymousMetrics: null }), /Invalid metrics/)
})

test('the theme family is a slug, not an enum, so a family this build never heard of still saves', () => {
  // The console falls back to ContextCake for an id it does not ship; the Mac
  // app must not reject the write (or an older client's sync pull) just
  // because a newer console added a family. Shape only: lowercase slug, at
  // most 32 characters, no path or case tricks.
  assert.deepEqual(validatePreferencePatch({ palette: 'solarized' }), { palette: 'solarized' })
  assert.deepEqual(validatePreferencePatch({ palette: 'a-family-added-later' }), { palette: 'a-family-added-later' })
  assert.deepEqual(validatePreferencePatch({ palette: 'x'.repeat(32) }), { palette: 'x'.repeat(32) })
  for (const bad of ['Solarized', '../x', 'x'.repeat(33), '', '-leading', 'with space', 42, null, {}]) {
    assert.throws(() => validatePreferencePatch({ palette: bad }), /Invalid palette/, `palette ${JSON.stringify(bad)} must be rejected`)
  }
  assert.deepEqual(changedPreferencePatch({ palette: 'contextcake' }, { palette: 'contextcake' }), {})
  assert.deepEqual(changedPreferencePatch({ palette: 'contextcake' }, { palette: 'gruvbox' }), { palette: 'gruvbox' })
})

test('reduce transparency accepts null as the way back to this Mac\'s setting', () => {
  // null is not "no value" here — it is the default and the only route back to
  // following Accessibility once the user has overridden it, so a validator that
  // treated it like a missing field would make the choice one-way.
  for (const value of [true, false, null]) {
    assert.deepEqual(validatePreferencePatch({ reducedTransparency: value }), { reducedTransparency: value })
  }
  assert.throws(() => validatePreferencePatch({ reducedTransparency: 'system' }), /Invalid transparency/)
  assert.throws(() => validatePreferencePatch({ reducedTransparency: 1 }), /Invalid transparency/)
})

test('choosing the value this Mac already reports is still a real change', () => {
  // The stored preference is null (following) and the Mac happens to say false.
  // Picking "Off" must persist `false` — the point is to stop following, so a
  // no-op filter that compared against the *effective* value would eat it.
  const current = { theme: 'system', density: 'comfortable', updateCheck: true, reducedTransparency: null }
  assert.deepEqual(changedPreferencePatch(current, { reducedTransparency: false }), { reducedTransparency: false })
  assert.deepEqual(changedPreferencePatch({ ...current, reducedTransparency: false }, { reducedTransparency: false }), {})
  assert.deepEqual(changedPreferencePatch({ ...current, reducedTransparency: false }, { reducedTransparency: null }), { reducedTransparency: null })
})

test('no-op preference changes produce no persistence patch', () => {
  const current = { theme: 'system', density: 'comfortable', updateCheck: true, anonymousMetrics: null }
  assert.deepEqual(changedPreferencePatch(current, { theme: 'system', density: 'comfortable' }), {})
  assert.deepEqual(changedPreferencePatch(current, { density: 'compact' }), { density: 'compact' })
})
