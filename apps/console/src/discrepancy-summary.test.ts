import { describe, expect, it } from 'vitest'
import {
  ACTIONABLE_STATUSES, buildHaystack, groupConflicts, isActionable, NO_SUMMARY, summarizeConflicts,
} from './discrepancy-summary'
import type { Conflict } from './data'

function conflict(overrides: Partial<Conflict> & { id: string }): Conflict {
  return {
    concept: 'decisions/primary-db', sectionKey: 'choice', section: 'Choice', title: 'Choice — Primary database',
    status: 'open', winner: 'personal', safe: false, history: [],
    kind: 'section_content', discrepancyStatus: 'needs_review', revision: 'rev-1',
    owner: 'Platform', conceptType: 'decision', conceptTitle: 'Primary database',
    contributions: [
      { layer: 'personal', sourceLayer: 'personal', value: 'SingleStore.', updated: '2026-05-12' },
      { layer: 'team', sourceLayer: 'team', value: 'Postgres.', updated: '2026-06-01' },
    ],
    ...overrides,
  }
}

const brokenLink = (id: string, target: string, best: string | null, extra: Partial<Conflict> = {}) => conflict({
  id, kind: 'broken_link', target, concept: `notes/${id}`, conceptTitle: `Note ${id}`,
  contributions: [{ layer: 'personal', sourceLayer: 'personal', value: target, updated: '2026-05-12' }],
  candidates: best ? [{ id: best, reason: 'case', confidence: 0.95 }] : [],
  bestCandidate: best ? { id: best, reason: 'case', confidence: 0.95 } : null,
  ...extra,
})

describe('isActionable', () => {
  it('is exactly the engine set, and treats a legacy open conflict as needs_review', () => {
    expect([...ACTIONABLE_STATUSES].sort()).toEqual(['auto_ready', 'blocked', 'needs_review', 'recommended', 'reopened'])
    for (const status of ACTIONABLE_STATUSES) expect(isActionable(conflict({ id: 'x', discrepancyStatus: status }))).toBe(true)
    expect(isActionable(conflict({ id: 'x', discrepancyStatus: 'acknowledged' }))).toBe(false)
    expect(isActionable(conflict({ id: 'x', discrepancyStatus: 'resolved' }))).toBe(false)
    expect(isActionable({ status: 'open' })).toBe(true)
    expect(isActionable({ status: 'resolved' })).toBe(false)
  })
})

describe('summarizeConflicts', () => {
  it('mirrors the engine shape: totals, per-kind, per-status, top groups and quick wins', () => {
    const summary = summarizeConflicts([
      conflict({ id: 'a' }),
      conflict({ id: 'b', discrepancyStatus: 'recommended', owner: 'Data' }),
      conflict({ id: 'c', discrepancyStatus: 'auto_ready', kind: 'frontmatter_value' }),
      conflict({ id: 'd', discrepancyStatus: 'acknowledged' }),
      brokenLink('l1', 'decisions/Old', 'decisions/old'),
      brokenLink('l2', 'decisions/Old', 'decisions/old'),
      brokenLink('l3', 'decisions/gone', null),
      brokenLink('l4', 'decisions/gone', null, { discrepancyStatus: 'acknowledged' }),
    ])
    expect(summary.total).toBe(8)
    expect(summary.actionable).toBe(6)
    expect(summary.byKind).toEqual({ section_content: 3, frontmatter_value: 1, broken_link: 4, changed_after_decision: 0 })
    expect(summary.byStatus).toMatchObject({ needs_review: 4, recommended: 1, auto_ready: 1, acknowledged: 2, resolved: 0, reopened: 0, blocked: 0 })
    expect(summary.quickWins).toEqual({ autoReady: 1, recommended: 1, brokenLinksWithBestCandidate: 2, brokenLinksTotal: 3 })
    // Largest target first; the shared fix survives only when every record agrees.
    expect(summary.topTargets).toEqual([
      { target: 'decisions/Old', count: 2, actionable: 2, bestCandidate: { id: 'decisions/old', reason: 'case', confidence: 0.95 } },
      { target: 'decisions/gone', count: 2, actionable: 1, bestCandidate: null },
    ])
    expect(summary.byOwner[0]).toEqual({ owner: 'Platform', count: 7, actionable: 5 })
    expect(summary.bySourcePair.map((row) => row.key)).toEqual(['personal', 'personal|team'])
    expect(summary.byConceptType[0].conceptType).toBe('decision')
    expect(summary.topConcepts[0]).toMatchObject({ conceptId: 'decisions/primary-db', conceptTitle: 'Primary database', count: 4 })
  })

  it('drops a shared best candidate the moment one record for the target disagrees', () => {
    const summary = summarizeConflicts([
      brokenLink('l1', 'x', 'x-a'),
      brokenLink('l2', 'x', 'x-b'),
    ])
    expect(summary.topTargets[0].bestCandidate).toBeNull()
  })

  it('answers the empty shape for no rows, and NO_SUMMARY has the same keys', () => {
    const empty = summarizeConflicts([])
    expect(Object.keys(empty).sort()).toEqual(Object.keys(NO_SUMMARY).sort())
    expect(empty.total).toBe(0)
    expect(empty.byKind).toEqual(NO_SUMMARY.byKind)
    expect(empty.byStatus).toEqual(NO_SUMMARY.byStatus)
  })
})

describe('groupConflicts', () => {
  const rows = [
    conflict({ id: 'a' }),
    conflict({ id: 'b', kind: 'frontmatter_value', owner: 'Data', concept: 'other', conceptTitle: 'Other' }),
    brokenLink('l1', 'decisions/Old', 'decisions/old'),
    brokenLink('l2', 'decisions/Old', 'decisions/old'),
    brokenLink('l3', 'decisions/Old', 'decisions/older'),
    brokenLink('l4', 'decisions/gone', null),
  ]

  it('kind mode sub-groups broken links by target and sorts the largest group first', () => {
    const groups = groupConflicts(rows, 'kind')
    expect(groups.map((group) => [group.label, group.count])).toEqual([
      ['Broken link → decisions/Old', 3],
      ['Broken link → decisions/gone', 1],
      ['Frontmatter value', 1],
      ['Section content', 1],
    ])
    const old = groups[0]
    expect(old.sharedTarget).toBe('decisions/Old')
    // Three links, two agree on the fix and one does not — no shared fix.
    expect(old.sharedBestCandidate).toBeNull()
    expect(old.actionable).toBe(3)
    expect(groups[3].sharedSources).toEqual(['personal', 'team'])
    expect(groups[3].sharedTarget).toBeUndefined()
  })

  it('carries the shared best candidate when every link in the target group agrees', () => {
    const [group] = groupConflicts([brokenLink('l1', 'x', 'y'), brokenLink('l2', 'x', 'y')], 'kind')
    expect(group.sharedBestCandidate).toEqual({ id: 'y', reason: 'case', confidence: 0.95 })
  })

  it('groups by concept, source pair and owner with stable keys', () => {
    // Equal counts fall back to the label, so the order is stable across refetches.
    expect(groupConflicts(rows, 'concept').map((group) => [group.key, group.label, group.count])).toEqual([
      ['concept:notes/l1', 'Note l1', 1],
      ['concept:notes/l2', 'Note l2', 1],
      ['concept:notes/l3', 'Note l3', 1],
      ['concept:notes/l4', 'Note l4', 1],
      ['concept:other', 'Other', 1],
      ['concept:decisions/primary-db', 'Primary database', 1],
    ])
    expect(groupConflicts(rows, 'sourcePair').map((group) => [group.label, group.count])).toEqual([
      ['personal', 4], ['personal + team', 2],
    ])
    expect(groupConflicts(rows, 'owner').map((group) => [group.label, group.count])).toEqual([
      ['Platform', 5], ['Data', 1],
    ])
    // The intersection of sources across a mixed group is what "Use <source> for N" may offer.
    const [platform] = groupConflicts(rows, 'owner')
    expect(platform.sharedSources).toBeUndefined() // contains broken links → no source action
    const [pair] = groupConflicts(rows.filter((row) => row.kind !== 'broken_link'), 'owner')
    expect(pair.sharedSources).toEqual(['personal', 'team'])
  })
})

describe('buildHaystack', () => {
  it('lowercases everything a search may match on, including the target and the suggested fix', () => {
    const hay = buildHaystack(brokenLink('l1', 'Decisions/Old', 'decisions/old'))
    expect(hay).toContain('decisions/old')
    expect(hay).toContain('note l1')
    expect(hay).not.toMatch(/[A-Z]/)
    expect(buildHaystack(conflict({ id: 'a' }))).toContain('singlestore.')
  })
})
