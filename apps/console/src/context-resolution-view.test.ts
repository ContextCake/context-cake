import { expect, it } from 'vitest'
import { withContextResolutionDecisions } from './context-resolution-view'
import { summarizeConflicts } from './discrepancy-summary'
import type { Conflict } from './data'
import type { ContextResolutionDecision } from './types'
const raw: Conflict = { id: 'd1', concept: 'decisions/db', sectionKey: 'choice', section: 'Choice', title: 'Database', kind: 'section_content', revision: 'rev1', status: 'open', discrepancyStatus: 'needs_review', safe: true, winner: 'personal', effectiveSource: 'personal', history: [], contributions: [{ layer: 'personal', sourceLayer: 'personal', value: 'SQLite', updated: '' }, { layer: 'team', sourceLayer: 'team', value: 'Postgres', updated: '' }] }
const decision: ContextResolutionDecision = { id: 'r1', policyId: 'p1', conceptId: raw.concept, key: raw.sectionKey, selectedSource: 'team', createdAt: '2026-09-06', currentStatus: 'applied', currentRevision: 'rev1' }
it('presents applied policies consistently without modifying the original discrepancy or its revision', () => {
  const original = structuredClone(raw)
  const shown = withContextResolutionDecisions([raw], [decision])
  expect(shown[0].effectiveSource).toBe('team')
  expect(shown[0].originalEffectiveSource).toBe('personal')
  expect(shown[0].contextResolution?.status).toBe('applied')
  expect(shown[0].contributions).toEqual(original.contributions)
  expect(shown[0].revision).toBe('rev1')
  expect(summarizeConflicts(shown).actionable).toBe(0)
  expect(summarizeConflicts(shown).byStatus.resolved).toBe(1)
  expect(raw).toEqual(original)
})
it('keeps stale, undone, unknown, and other-scope decisions in review', () => {
  for (const changed of [{ ...decision, currentStatus: 'stale' as const }, { ...decision, currentStatus: undefined }, { ...decision, currentRevision: 'newer-revision' }, { ...decision, currentRevision: undefined }, { ...decision, undoneAt: '2026-09-06' }, { ...decision, conceptId: 'other-project/db' }]) {
    expect(withContextResolutionDecisions([raw], [changed])[0]).toBe(raw)
  }
  expect(withContextResolutionDecisions([raw], [decision, { ...decision, id: 'r2', currentStatus: 'undone', undoneAt: '2026-09-06' }])[0]).toBe(raw)
})
