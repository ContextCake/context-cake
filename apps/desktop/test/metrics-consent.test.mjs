import assert from 'node:assert/strict'
import test from 'node:test'
import { manifestLayerCount, shouldDeferConsentPrompt } from '../src/main/metrics-consent.mjs'

test('counts layers across legacy, transitional and profiles-v2 manifests', () => {
  assert.equal(manifestLayerCount({}), 0)
  assert.equal(manifestLayerCount({ layers: [] }), 0)
  assert.equal(manifestLayerCount({ layers: [{ name: 'personal', level: 3, path: '/kb' }] }), 1)
  assert.equal(manifestLayerCount({
    layers: [{ name: 'personal' }],
    profiles: { work: { layers: [{ name: 'team' }, { name: 'company' }] } },
  }), 3)
  assert.equal(manifestLayerCount({
    profiles: {
      default: { layers: [{ name: 'personal' }] },
      work: { layers: [{ name: 'team' }] },
    },
  }), 2)
})

test('malformed manifest content never throws and counts as zero layers', () => {
  assert.equal(manifestLayerCount(null), 0)
  assert.equal(manifestLayerCount(undefined), 0)
  assert.equal(manifestLayerCount('not an object'), 0)
  assert.equal(manifestLayerCount([]), 0)
  assert.equal(manifestLayerCount({ layers: 'nope' }), 0)
  assert.equal(manifestLayerCount({ profiles: 'nope' }), 0)
  assert.equal(manifestLayerCount({ profiles: { broken: null } }), 0)
  assert.equal(manifestLayerCount({ profiles: { broken: { layers: 'nope' } } }), 0)
  assert.equal(manifestLayerCount({ profiles: [{ layers: [{ name: 'x' }] }] }), 0)
})

test('defers the consent prompt only for an unanswered fresh install with zero layers', () => {
  // Fresh install, wizard not finished: wait for the first layer.
  assert.equal(shouldDeferConsentPrompt({ storedPreference: undefined, manifest: {} }), true)
  assert.equal(shouldDeferConsentPrompt({ storedPreference: null, manifest: { layers: [] } }), true)

  // Upgrade or skipped-wizard-revisited: layers exist, prompt at boot as before.
  assert.equal(shouldDeferConsentPrompt({
    storedPreference: undefined,
    manifest: { layers: [{ name: 'personal', level: 3, path: '/kb' }] },
  }), false)
  assert.equal(shouldDeferConsentPrompt({
    storedPreference: undefined,
    manifest: { profiles: { default: { layers: [{ name: 'personal' }] } } },
  }), false)

  // An answered preference means there is nothing to ask, ever.
  assert.equal(shouldDeferConsentPrompt({ storedPreference: true, manifest: {} }), false)
  assert.equal(shouldDeferConsentPrompt({ storedPreference: false, manifest: {} }), false)
  assert.equal(shouldDeferConsentPrompt({ storedPreference: false, manifest: { layers: [{ name: 'p' }] } }), false)
})
