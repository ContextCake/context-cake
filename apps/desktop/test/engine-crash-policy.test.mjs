import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CRASH_BACKOFFS_MS,
  CRASH_WINDOW_MS,
  appendBreadcrumb,
  nextRestartDecision,
  pruneRestarts,
  quarantineCandidate,
} from '../src/main/engine-crash-policy.mjs'

test('first two crashes in a window restart with escalating backoff, the third does not', () => {
  assert.deepEqual(nextRestartDecision([]), { restart: true, backoffMs: CRASH_BACKOFFS_MS[0] })
  assert.deepEqual(nextRestartDecision([1_000]), { restart: true, backoffMs: CRASH_BACKOFFS_MS[1] })
  assert.deepEqual(nextRestartDecision([1_000, 2_000]), { restart: false, backoffMs: null })
})

test('restarts age out of the window, so an old bad afternoon does not count today', () => {
  const now = 1_000_000_000
  const stale = now - CRASH_WINDOW_MS - 1
  const fresh = now - 1_000
  assert.deepEqual(pruneRestarts([stale, fresh], now), [fresh])
  assert.deepEqual(nextRestartDecision(pruneRestarts([stale, stale], now)), {
    restart: true,
    backoffMs: CRASH_BACKOFFS_MS[0],
  })
})

test('quarantine names the suspect only on a single-name intersection of the last two crashes', () => {
  const crumb = (sources) => ({ at: 'x', code: 1, indexingSources: sources })
  // Two crashes, one shared source: the suspect.
  assert.equal(quarantineCandidate([crumb(['vault']), crumb(['vault'])]), 'vault')
  assert.equal(quarantineCandidate([crumb(['vault', 'docs']), crumb(['vault'])]), 'vault')
  // Ambiguous: two sources mid-index both times — blame nobody.
  assert.equal(quarantineCandidate([crumb(['vault', 'docs']), crumb(['docs', 'vault'])]), null)
  // Disjoint: nothing shared.
  assert.equal(quarantineCandidate([crumb(['vault']), crumb(['docs'])]), null)
  // One crash is not a pattern.
  assert.equal(quarantineCandidate([crumb(['vault'])]), null)
  assert.equal(quarantineCandidate([]), null)
  // Crashes observed with no index running carry nothing to intersect.
  assert.equal(quarantineCandidate([crumb(null), crumb(['vault'])]), null)
  // Only the two MOST RECENT crashes speak: older history does not vote.
  assert.equal(quarantineCandidate([crumb(['vault']), crumb(['docs']), crumb(['docs'])]), 'docs')
})

test('breadcrumbs stay bounded at the limit, newest kept', () => {
  let list = []
  for (let i = 0; i < 9; i++) list = appendBreadcrumb(list, { at: i })
  assert.equal(list.length, 5)
  assert.deepEqual(list.map((e) => e.at), [4, 5, 6, 7, 8])
})
