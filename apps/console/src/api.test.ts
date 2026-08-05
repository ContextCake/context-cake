// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adaptConcept, adaptConflicts, adaptSources, apiFetch, LiveDataError, selectMode, trivialConflictReason,
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

  it('reports a request timeout honestly — an eternal "Resolving…" is never an option', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'))
    const source = createDataSource('live')

    await expect(source.graph()).rejects.toMatchObject({
      kind: 'unreachable',
      message: expect.stringContaining('took too long'),
    })
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

describe('desktop API credential transport', () => {
  afterEach(() => {
    delete window.__CC_DESKTOP
    vi.unstubAllGlobals()
  })

  it('gets the bearer through trusted IPC instead of renderer process arguments', async () => {
    window.__CC_DESKTOP = {
      getApiToken: vi.fn().mockResolvedValue('launch-secret'),
      version: '0.2.0',
      authState: { signedIn: false },
      cli: { getStatus: vi.fn(), install: vi.fn() },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))

    await apiFetch('/api/graph')

    expect(window.__CC_DESKTOP.getApiToken).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('/api/graph', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer launch-secret')
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

  it('maps a degraded source to its own status, not a healthy one', () => {
    // The row a rate-limited GitHub layer produces: it listed without throwing
    // (warn-and-continue), so only `status` separates it from an empty repo.
    const graph: GraphSummary = {
      totals: { sourceTokens: 20, resolvedTokens: 20, concepts: 2, sources: 1 },
      sources: [
        {
          name: 'repo', level: 3, kind: 'github', conceptCount: 2, tokens: 20, latestUpdated: null,
          status: 'degraded', error: 'GitHub API 403 on /repos/acme/payments',
          lastErrorAt: '2026-07-28T10:05:00.000Z', lastSuccessAt: '2026-07-28T09:00:00.000Z',
        },
      ],
      concepts: [],
    }
    const [repo] = adaptSources(graph)
    expect(repo.status).toBe('degraded')
    expect(repo.focus).toContain('GitHub API 403')
    expect(repo.focus).toContain('2026-07-28T09:00:00.000Z') // how stale what it serves is
    expect(repo.coverage).toBe(100) // it is still serving those two concepts
  })

  it('gives a source contributing nothing an empty coverage bar', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
      sources: [
        { name: 'repo', level: 3, kind: 'github', conceptCount: 0, tokens: 0, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    expect(adaptSources(graph)[0].coverage).toBe(0)
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

  it('never paints a zero-concept MCP source as serving (the false green)', () => {
    // A dead MCP child answers [] instead of throwing, so its row arrives
    // status 'ok' with nothing served — that must not read as healthy.
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
      sources: [
        { name: 'company-mcp', level: 0, kind: 'mcp', conceptCount: 0, tokens: 0, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    const [mcp] = adaptSources(graph)
    expect(mcp.status).toBe('empty')
    expect(mcp.status).not.toBe('serving')
    expect(mcp.coverage).toBe(0)
    expect(mcp.focus).toContain('nothing served yet')
  })

  it('treats an ok-status MCP row that still carries an error as degraded, not serving', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 5, resolvedTokens: 5, concepts: 1, sources: 1 },
      sources: [
        { name: 'company-mcp', level: 0, kind: 'mcp', conceptCount: 1, tokens: 5, latestUpdated: null, status: 'ok', error: 'child exited (code 1)' },
      ],
      concepts: [],
    }
    expect(adaptSources(graph)[0].status).toBe('degraded')
  })

  it('keeps serving strictly for MCP sources with concepts and no recorded failure', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 50, resolvedTokens: 50, concepts: 126, sources: 1 },
      sources: [
        { name: 'company-mcp', level: 0, kind: 'mcp', conceptCount: 126, tokens: 50, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    expect(adaptSources(graph)[0].status).toBe('serving')
  })

  it('carries the raw kind, level, health timestamps, and live flag for management', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 10, resolvedTokens: 10, concepts: 1, sources: 2 },
      sources: [
        {
          name: 'acme-docs', level: 2, kind: 'github', conceptCount: 4, tokens: 10, latestUpdated: null,
          status: 'ok', error: null, lastSuccessAt: '2026-08-01T10:00:00.000Z', lastErrorAt: null, live: true,
          authAlias: 'github.com/octocat', authState: 'ok',
        },
        { name: 'notes', level: 3, kind: 'files', conceptCount: 2, tokens: 4, latestUpdated: null, status: 'ok', error: null, origin: null },
      ],
      concepts: [],
    }
    const [repo, notes] = adaptSources(graph)
    expect(repo).toMatchObject({
      sourceKind: 'github', level: 2, conceptCount: 4,
      lastSuccessAt: '2026-08-01T10:00:00.000Z', live: true,
      authAlias: 'github.com/octocat', authState: 'ok',
    })
    expect(notes.sourceKind).toBe('files')
    expect(notes.live).toBeUndefined()
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

  it('classifies formatting-only prose but never guesses when words or code change', () => {
    expect(trivialConflictReason(['Use **Postgres** for writes.', 'Use postgres for writes'])).toMatch(/same words/)
    expect(trivialConflictReason(['Use Postgres.', 'Use MySQL.'])).toBeNull()
    expect(trivialConflictReason(['Run `npm test`.', 'Run npm test.'])).toBeNull()
  })

  it('keeps a custom layer at its saved precedence after the source conflict is gone', () => {
    const [resolved] = adaptConflicts([], [{
      schemaVersion: 1,
      id: 'resolution-1',
      conflictId: 'decisions/primary-db::choice',
      conceptId: 'decisions/primary-db',
      title: 'Primary database',
      sectionKey: 'choice',
      sectionHeading: '## Choice {#choice}',
      contributions: [
        { layer: 'acme-eng', level: 2, content: 'SingleStore.', updated: '2026-01-01' },
        { layer: 'org-policy', level: 0, content: 'Postgres.', updated: '2025-01-01' },
      ],
      chosen: { layer: 'acme-eng', level: 2, content: 'SingleStore.', updated: '2026-01-01' },
      method: 'manual',
      reason: 'You chose the acme-eng answer.',
      actor: 'local-user',
      decidedAt: '2026-08-05T00:00:00.000Z',
    }])

    expect(resolved.status).toBe('resolved')
    expect(resolved.winner).toBe('team')
    expect(resolved.contributions.map((item) => item.layer)).toEqual(['team', 'company'])
  })
})

// ---- fresherDissent carry-through (contract C-b) -------------------------

describe('fresherDissent (C-b)', () => {
  function conflicted(section: Partial<ResolvedConcept['sections'][0]>): ResolvedConcept {
    return {
      id: 'decisions/primary-db',
      contributors: [
        { layer: 'personal', level: 3, updated: '2026-05-12' },
        { layer: 'team', level: 2, updated: '2026-06-01' },
      ],
      frontmatter: { title: 'Primary database' },
      sections: [{
        key: 'choice', heading: '## Choice {#choice}', content: 'SingleStore.',
        sourceLayer: 'personal', sourceUpdated: '2026-05-12',
        conflicts: [{ layer: 'team', updated: '2026-06-01', content: 'Postgres.' }],
        ...section,
      }],
    }
  }

  it('carries the section flag through adaptConcept onto the view section', () => {
    const c = adaptConcept(conflicted({ fresherDissent: true }))
    expect(c.sections[0].fresherDissent).toBe(true)
    expect(adaptConcept(conflicted({})).sections[0].fresherDissent).toBeUndefined()
  })

  it('marks exactly the strictly-newer dissent contribution on the conflict card', () => {
    const concept = conflicted({
      fresherDissent: true,
      conflicts: [
        { layer: 'team', updated: '2026-06-01', content: 'Postgres.' },
        { layer: 'company', updated: '2025-01-01', content: 'MySQL.' },
      ],
    })
    concept.contributors.push({ layer: 'company', level: 0, updated: '2025-01-01' })
    const [card] = adaptConflicts([concept])
    expect(card.contributions[0].fresherDissent).toBeUndefined() // the winner is never its own dissent
    expect(card.contributions[1]).toMatchObject({ layer: 'team', fresherDissent: true })
    expect(card.contributions[2].fresherDissent).toBeUndefined() // older dissent stays unmarked
  })

  it('never marks a dissent when the engine did not flag the section', () => {
    // The engine owns the rule (it also knows about suppression and
    // formatting-equivalence); the console must not out-guess it.
    const [card] = adaptConflicts([conflicted({})])
    expect(card.contributions.every((k) => k.fresherDissent === undefined)).toBe(true)
  })

  it('does not treat a same-day datetime as newer than a date-only value', () => {
    // MCP layers carry arbitrary lastTouched datetimes; day granularity rules.
    const concept = conflicted({
      fresherDissent: true, // flagged because of a second, genuinely newer dissent
      conflicts: [
        { layer: 'team', updated: '2026-05-12T23:59:59Z', content: 'Same day.' },
        { layer: 'company', updated: '2026-06-01', content: 'Actually newer.' },
      ],
    })
    concept.contributors.push({ layer: 'company', level: 0, updated: '2026-06-01' })
    const [card] = adaptConflicts([concept])
    expect(card.contributions[1].fresherDissent).toBeUndefined()
    expect(card.contributions[2].fresherDissent).toBe(true)
  })

  it('never treats a missing or unparseable date as epoch 0', () => {
    const concept = conflicted({
      fresherDissent: true,
      sourceUpdated: null,
      conflicts: [{ layer: 'team', updated: '2026-06-01', content: 'Dated dissent.' }],
    })
    const [card] = adaptConflicts([concept])
    expect(card.contributions[1].fresherDissent).toBeUndefined()

    const garbled = conflicted({
      fresherDissent: true,
      conflicts: [{ layer: 'team', updated: 'not-a-date', content: 'Undated dissent.' }],
    })
    expect(adaptConflicts([garbled])[0].contributions[1].fresherDissent).toBeUndefined()
  })
})
