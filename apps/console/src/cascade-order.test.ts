// The cascade-order helper is the console's one answer to "which layer wins",
// so its rules are pinned here rather than inferred from the views: dense
// ranks that share on ties, lanes that come from the same distinct-level list
// as the ranks (parity with the old computeLevelBuckets), a tie order that is
// byte-for-byte the engine's (`a < b`, not localeCompare), and the list
// mutation the reorder UI sends.
import { describe, expect, it } from 'vitest'
import {
  cascadeOrderNames, compareNames, computeCascadeOrder, computeLevelBuckets, distinctLevelsDesc, layerOf, moveTo,
  positionOptions, rankLabel, winsOverHint,
} from './cascade-order'
import { computeLevelBuckets as reexported } from './api'

const trio = [
  { name: 'company', level: 0 },
  { name: 'personal', level: 3 },
  { name: 'team', level: 2 },
]

describe('distinctLevelsDesc', () => {
  it('lists each level once, highest first', () => {
    expect(distinctLevelsDesc([0, 2, 2, 3, 0])).toEqual([3, 2, 0])
    expect(distinctLevelsDesc([])).toEqual([])
  })
})

// The four cases that used to live in api.test.ts, ported so the mapping's
// contract is pinned where the code now lives.
describe('computeLevelBuckets', () => {
  it('ranks the highest level present as personal, the next as team, the rest as company', () => {
    const buckets = computeLevelBuckets([0, 1, 2, 3])
    expect(buckets.get(3)).toBe('personal')
    expect(buckets.get(2)).toBe('team')
    expect(buckets.get(1)).toBe('company')
    expect(buckets.get(0)).toBe('company')
  })

  it('puts the sole level present in the top lane rather than folding it into company', () => {
    expect(computeLevelBuckets([1]).get(1)).toBe('personal')
  })

  it('promotes a second-place level to team even when it is not 2', () => {
    expect(computeLevelBuckets([3, 1]).get(1)).toBe('team')
    expect(computeLevelBuckets([5, 4]).get(4)).toBe('team')
  })

  it('ignores duplicate levels when ranking', () => {
    const buckets = computeLevelBuckets([2, 2, 0, 0])
    expect(buckets.get(2)).toBe('personal')
    expect(buckets.get(0)).toBe('team')
  })

  it('is the same function api.ts re-exports, so the ~12 adapter call sites did not fork', () => {
    expect(reexported).toBe(computeLevelBuckets)
  })
})

describe('layerOf', () => {
  it('lets a canonical name win over its rank bucket, and falls back to the bucket otherwise', () => {
    const buckets = computeLevelBuckets([3, 1])
    expect(layerOf('team', 3, buckets)).toBe('team')
    expect(layerOf('messy-vault', 1, buckets)).toBe('team')
    expect(layerOf('orphan', 9, buckets)).toBe('company')
  })
})

describe('computeCascadeOrder', () => {
  it('assigns dense 1-based ranks, highest level first, and sorts by rank', () => {
    const order = computeCascadeOrder(trio)
    expect(order.map((s) => [s.name, s.rank])).toEqual([['personal', 1], ['team', 2], ['company', 3]])
    expect(order.every((s) => s.tied === false)).toBe(true)
  })

  it('shares a rank across a tie and keeps the next distinct level dense', () => {
    const order = computeCascadeOrder([
      { name: 'zeta', level: 2 },
      { name: 'alpha', level: 2 },
      { name: 'base', level: 0 },
      { name: 'top', level: 5 },
    ])
    expect(order.map((s) => `${s.name}:${s.rank}${s.tied ? '*' : ''}`)).toEqual(['top:1', 'alpha:2*', 'zeta:2*', 'base:3'])
  })

  it('derives the lane from the same distinct-level list as the rank — buckets and ranks cannot drift', () => {
    const sources = [{ name: 'messy-vault', level: 1 }, { name: 'notes', level: 3 }, { name: 'graph', level: 0 }, { name: 'archive', level: 0 }]
    const order = computeCascadeOrder(sources)
    const buckets = computeLevelBuckets(sources.map((s) => s.level))
    for (const entry of order) {
      expect(entry.layer).toBe(buckets.get(entry.level))
      expect(entry.rank).toBe(distinctLevelsDesc(sources.map((s) => s.level)).indexOf(entry.level) + 1)
    }
    expect(order.find((s) => s.name === 'messy-vault')?.layer).toBe('team')
  })

  it('carries every input field through unchanged', () => {
    const order = computeCascadeOrder([{ name: 'a', level: 1, sourceKind: 'files', conceptCount: 4 }])
    expect(order[0]).toMatchObject({ name: 'a', level: 1, sourceKind: 'files', conceptCount: 4, rank: 1, tied: false, layer: 'personal' })
  })

  it('keeps a lane the store already assigned — one mapping per row, never two that could disagree', () => {
    // adaptSources ran layerOf over the same list; a second computation here
    // could only agree, or (in a test fixture) contradict the lane every
    // other view already renders the row in.
    const order = computeCascadeOrder([{ name: 'acme-eng', level: 2, layer: 'team' as const }])
    expect(order[0].layer).toBe('team')
  })

  it('handles an empty cascade', () => {
    expect(computeCascadeOrder([])).toEqual([])
    expect(cascadeOrderNames([])).toEqual([])
  })
})

describe('cascadeOrderNames — the list PUT /api/sources/order takes', () => {
  it('is rank ascending, index 0 wins', () => {
    expect(cascadeOrderNames(trio)).toEqual(['personal', 'team', 'company'])
  })

  it('breaks ties by plain code-point comparison, exactly like the engine (not localeCompare)', () => {
    // localeCompare would put "a" before "B" and "é" beside "e"; code points
    // put every uppercase letter before every lowercase one and "é" last.
    // The engine's cascadeOrder() sorts with `a < b`, and an insert-at-
    // position computed there has to land where this list says it will.
    const tied = [
      { name: 'b', level: 2 }, { name: 'B', level: 2 }, { name: 'a', level: 2 }, { name: 'é', level: 2 }, { name: 'Z', level: 2 },
    ]
    const engineOrder = [...tied].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)).map((s) => s.name)
    expect(cascadeOrderNames(tied)).toEqual(engineOrder)
    expect(cascadeOrderNames(tied)).toEqual(['B', 'Z', 'a', 'b', 'é'])
    expect(cascadeOrderNames(tied)).not.toEqual([...tied].map((s) => s.name).sort((x, y) => x.localeCompare(y)))
  })

  it('compareNames is that comparison', () => {
    expect(compareNames('B', 'a')).toBe(-1)
    expect(compareNames('a', 'a')).toBe(0)
    expect(compareNames('b', 'a')).toBe(1)
  })
})

describe('moveTo', () => {
  const order = ['personal', 'team', 'company']

  it('moves a name to a 0-based index and shifts the rest', () => {
    expect(moveTo(order, 'company', 0)).toEqual(['company', 'personal', 'team'])
    expect(moveTo(order, 'personal', 2)).toEqual(['team', 'company', 'personal'])
    expect(moveTo(order, 'team', 0)).toEqual(['team', 'personal', 'company'])
  })

  it('clamps out-of-range targets to the ends and never mutates its input', () => {
    expect(moveTo(order, 'personal', 99)).toEqual(['team', 'company', 'personal'])
    expect(moveTo(order, 'company', -4)).toEqual(['company', 'personal', 'team'])
    expect(order).toEqual(['personal', 'team', 'company'])
  })

  it('returns a copy unchanged for a name that is not in the list', () => {
    const out = moveTo(order, 'ghost', 0)
    expect(out).toEqual(order)
    expect(out).not.toBe(order)
  })

  it('is a no-op move when the target is where the name already is', () => {
    expect(moveTo(order, 'team', 1)).toEqual(order)
  })
})

describe('labels', () => {
  it('rankLabel marks a tie', () => {
    expect(rankLabel({ rank: 1, tied: false })).toBe('#1')
    expect(rankLabel({ rank: 2, tied: true })).toBe('#2 (tied)')
  })

  it('winsOverHint names who a position beats, the base, and a tie', () => {
    const order = computeCascadeOrder(trio)
    const [personal, team, company] = order
    expect(winsOverHint(personal, order)).toBe('Wins over team, company')
    expect(winsOverHint(team, order)).toBe('Wins over company')
    expect(winsOverHint(company, order)).toBe('Base — everything above inherits from it')

    const tied = computeCascadeOrder([{ name: 'a', level: 2 }, { name: 'b', level: 2 }, { name: 'c', level: 0 }])
    expect(winsOverHint(tied[0], tied)).toBe('Tied with b — most recently updated wins')

    const only = computeCascadeOrder([{ name: 'solo', level: 1 }])
    expect(winsOverHint(only[0], only)).toMatch(/only source/)
  })

  it('winsOverHint caps a long list so a row stays a row', () => {
    const many = computeCascadeOrder([{ name: 'top', level: 9 }, ...['a', 'b', 'c', 'd', 'e'].map((name, i) => ({ name, level: 5 - i }))])
    expect(winsOverHint(many[0], many)).toBe('Wins over a, b, c and 2 more')
  })

  it('positionOptions offers one slot more than the names above it, each naming what it sits below', () => {
    expect(positionOptions([])).toEqual([{ value: 1, label: '1 — the only source' }])
    expect(positionOptions(['personal', 'team', 'company'])).toEqual([
      { value: 1, label: '1 — top (wins over everything)' },
      { value: 2, label: '2 — below personal' },
      { value: 3, label: '3 — below team' },
      { value: 4, label: '4 — bottom (below company)' },
    ])
    expect(positionOptions(['only'])).toEqual([
      { value: 1, label: '1 — top (wins over everything)' },
      { value: 2, label: '2 — bottom (below only)' },
    ])
  })
})
