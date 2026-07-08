// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adaptConcept, adaptConflicts, adaptSources, LiveDataError, selectMode,
} from './api'
import type { GraphSummary, ResolvedConcept } from './types'

// ---- selectMode -------------------------------------------------------

describe('selectMode', () => {
  const originalLocation = window.location

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true })
  })

  function stubLocation(search: string, pathname: string) {
    Object.defineProperty(window, 'location', {
      value: { search, pathname } as Location,
      writable: true,
      configurable: true,
    })
  }

  it('forces live via ?mode=live', () => {
    stubLocation('?mode=live', '/')
    expect(selectMode()).toBe('live')
  })

  it('forces demo via ?mode=demo even under /console', () => {
    stubLocation('?mode=demo', '/console/')
    expect(selectMode()).toBe('demo')
  })

  it('defaults to live when served under /console', () => {
    stubLocation('', '/console/')
    expect(selectMode()).toBe('live')
  })

  it('defaults to demo otherwise', () => {
    stubLocation('', '/')
    expect(selectMode()).toBe('demo')
  })
})

// ---- LiveSource error taxonomy -----------------------------------------
// LiveSource isn't exported directly; createDataSource('live') returns one.
// Re-import here so each test gets a fresh fetch stub.

describe('LiveSource error taxonomy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws a LiveDataError with kind "unreachable" when fetch throws', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    const source = createDataSource('live')

    await expect(source.graph()).rejects.toMatchObject({ kind: 'unreachable' })
    await expect(source.graph()).rejects.toBeInstanceOf(LiveDataError)
  })

  it('throws a LiveDataError with kind "bad-status" and the status on non-ok', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const source = createDataSource('live')

    await expect(source.graph()).rejects.toMatchObject({ kind: 'bad-status', status: 500 })
  })

  it('throws a LiveDataError with kind "bad-shape" on invalid JSON', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('bad json') },
    } as unknown as Response)
    const source = createDataSource('live')

    await expect(source.graph()).rejects.toMatchObject({ kind: 'bad-shape' })
  })

  it('never falls back to demo data on error — it throws', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockRejectedValue(new TypeError('network down'))
    const source = createDataSource('live')

    expect(source.mode).toBe('live')
    await expect(source.graph()).rejects.toBeInstanceOf(LiveDataError)
    // Confirm the rejection is not silently swallowed into some demo-shaped value.
  })
})

// ---- Adapters: raw engine types -> console view model -------------------

describe('adaptConcept', () => {
  const sample: ResolvedConcept = {
    id: 'decisions/primary-db',
    contributors: [
      { layer: 'team', level: 2, updated: '2026-01-01' },
      { layer: 'company', level: 0, updated: '2025-06-01' },
    ],
    frontmatter: { title: 'Primary database', type: 'decision' },
    sections: [
      {
        key: 'choice',
        heading: '## Choice {#choice}',
        content: 'SingleStore for HTAP workloads.',
        sourceLayer: 'team',
        sourceUpdated: '2026-01-01',
        conflicts: [
          { layer: 'company', updated: '2025-06-01', content: 'Postgres (org standard).' },
        ],
      },
    ],
  }

  it('maps id, title, and type from frontmatter', () => {
    const c = adaptConcept(sample)
    expect(c.id).toBe('decisions/primary-db')
    expect(c.title).toBe('Primary database')
    expect(c.type).toBe('decision')
  })

  it('orders contributing layers by precedence (personal, team, company)', () => {
    const c = adaptConcept(sample)
    expect(c.layers).toEqual(['team', 'company'])
  })

  it('marks conflict true when any section has dissents', () => {
    const c = adaptConcept(sample)
    expect(c.conflict).toBe(true)
  })

  it('marks draft only from OKF frontmatter (write.mjs stamps auto-captures)', () => {
    const stamped: ResolvedConcept = { ...sample, frontmatter: { ...sample.frontmatter, draft: true } }
    expect(adaptConcept(stamped).draft).toBe(true)
    expect(adaptConcept(sample).draft).toBe(false)
    // A concept owned by a single layer is NOT draft — finished knowledge
    // commonly lives in exactly one layer.
    const solo: ResolvedConcept = { ...sample, contributors: [sample.contributors[0]], sections: [] }
    expect(adaptConcept(solo).draft).toBe(false)
  })

  it('maps non-canonical layer names via contributor levels, not the name', () => {
    const custom: ResolvedConcept = {
      id: 'decisions/primary-db',
      contributors: [
        { layer: 'acme-eng', level: 2, updated: '2026-01-01' },
        { layer: 'company', level: 0, updated: '2025-06-01' },
      ],
      frontmatter: { title: 'Primary database', type: 'decision' },
      sections: [
        {
          key: 'choice',
          heading: '## Choice {#choice}',
          content: 'SingleStore for HTAP workloads.',
          sourceLayer: 'acme-eng',
          sourceUpdated: '2026-01-01',
          conflicts: [
            { layer: 'company', updated: '2025-06-01', content: 'Postgres (org standard).' },
          ],
        },
      ],
    }
    const c = adaptConcept(custom)
    expect(c.sections[0].winner).toBe('team')
    expect(c.layers).toEqual(['team', 'company'])
    const cards = adaptConflicts([custom])
    expect(cards[0].winner).toBe('team')
    expect(cards[0].contributions[0].layer).toBe('team')
  })

  it('maps section winner, value, and provenance date', () => {
    const c = adaptConcept(sample)
    const s = c.sections[0]
    expect(s.name).toBe('Choice')
    expect(s.winner).toBe('team')
    expect(s.value).toBe('SingleStore for HTAP workloads.')
    expect(s.updated).toBe('2026-01-01')
  })

  it('surfaces dissenting layers on the section, not hidden', () => {
    const c = adaptConcept(sample)
    const s = c.sections[0]
    expect(s.dissents).toHaveLength(1)
    expect(s.dissents?.[0]).toMatchObject({ layer: 'company', value: 'Postgres (org standard).', updated: '2025-06-01' })
  })

  it('marks a section suppressed when the engine flags override=none', () => {
    const suppressed: ResolvedConcept = {
      ...sample,
      sections: [{ ...sample.sections[0], suppressed: true, conflicts: undefined }],
    }
    const c = adaptConcept(suppressed)
    expect(c.sections[0].suppressed).toBe(true)
    expect(c.sections[0].dissents).toEqual([])
  })
})

describe('adaptSources', () => {
  it('maps a healthy source to synced/serving status by kind, with full coverage', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 100, resolvedTokens: 100, concepts: 1, sources: 2 },
      sources: [
        { name: 'personal', level: 3, kind: 'okf-local', conceptCount: 14, tokens: 50, latestUpdated: null, status: 'ok', error: null },
        { name: 'company-mcp', level: 0, kind: 'mcp', conceptCount: 126, tokens: 50, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    const [personal, mcp] = adaptSources(graph)
    expect(personal).toMatchObject({ name: 'personal', kind: 'okf-local', layer: 'personal', coverage: 100, status: 'synced' })
    expect(mcp).toMatchObject({ name: 'company-mcp', kind: 'mcp', status: 'serving', coverage: 100 })
  })

  it('maps an errored source to zero coverage and an honest error focus', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
      sources: [
        { name: 'team', level: 2, kind: 'okf-local', conceptCount: 0, tokens: 0, latestUpdated: null, status: 'error', error: 'ENOENT: no such directory' },
      ],
      concepts: [],
    }
    const [team] = adaptSources(graph)
    expect(team.status).toBe('error')
    expect(team.coverage).toBe(0)
    expect(team.focus).toBe('ENOENT: no such directory')
  })

  it('falls back to level-based layer inference for non-canonical source names', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 10, resolvedTokens: 10, concepts: 1, sources: 1 },
      sources: [
        { name: 'design-docs', level: 3, kind: 'okf-local', conceptCount: 1, tokens: 10, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    expect(adaptSources(graph)[0].layer).toBe('personal')
  })
})

describe('adaptConflicts', () => {
  it('derives one conflict card per conflicted section, winner first', () => {
    const concepts: ResolvedConcept[] = [
      {
        id: 'decisions/primary-db',
        contributors: [{ layer: 'team', level: 2, updated: null }],
        frontmatter: { title: 'Primary database' },
        sections: [
          {
            key: 'choice', heading: '## Choice {#choice}', content: 'SingleStore.',
            sourceLayer: 'team', sourceUpdated: '2026-01-01',
            conflicts: [{ layer: 'company', updated: '2025-06-01', content: 'Postgres.' }],
          },
          {
            key: 'notes', heading: '## Notes {#notes}', content: 'No conflict here.',
            sourceLayer: 'team', sourceUpdated: '2026-01-01',
          },
        ],
      },
    ]
    const out = adaptConflicts(concepts)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'decisions/primary-db::choice',
      concept: 'decisions/primary-db',
      section: 'Choice',
      status: 'open',
      winner: 'team',
    })
    expect(out[0].contributions[0]).toMatchObject({ layer: 'team', value: 'SingleStore.' })
    expect(out[0].contributions[1]).toMatchObject({ layer: 'company', value: 'Postgres.' })
  })

  it('produces no cards when nothing conflicts', () => {
    const concepts: ResolvedConcept[] = [
      {
        id: 'runbooks/deploy',
        contributors: [{ layer: 'team', level: 2, updated: null }],
        frontmatter: {},
        sections: [{ key: 'steps', heading: '## Steps {#steps}', content: 'Deploy.', sourceLayer: 'team', sourceUpdated: null }],
      },
    ]
    expect(adaptConflicts(concepts)).toEqual([])
  })
})
