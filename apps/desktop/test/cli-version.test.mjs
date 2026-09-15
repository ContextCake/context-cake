import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { cliVersionCandidates, readCliVersion } from '../src/cli/version.mjs'

test('CLI reads the desktop package version in a development checkout', () => {
  const here = '/repo/apps/desktop/src/cli'
  const [development] = cliVersionCandidates(here)
  assert.equal(development, path.resolve('/repo/apps/desktop/package.json'))
  assert.equal(readCliVersion(here, (candidate) => {
    assert.equal(candidate, development)
    return '{"version":"0.9.1"}'
  }), '0.9.1')
})

test('CLI falls back to the packaged package.json inside app.asar', () => {
  const here = '/Applications/ContextCake.app/Contents/Resources/engine/cli'
  const [development, packaged] = cliVersionCandidates(here)
  assert.equal(packaged, '/Applications/ContextCake.app/Contents/Resources/app.asar/package.json')

  const reads = []
  const version = readCliVersion(here, (candidate) => {
    reads.push(candidate)
    if (candidate === development) throw new Error('not present')
    return '{"version":"0.9.1"}'
  })

  assert.equal(version, '0.9.1')
  assert.deepEqual(reads, [development, packaged])
})

test('CLI reports unknown only when neither supported package is readable', () => {
  assert.equal(readCliVersion('/missing', () => { throw new Error('not present') }), 'unknown')
})
