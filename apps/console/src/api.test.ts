// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adaptConcept, adaptConflicts, adaptSources, apiFetch, LiveDataError, mergeSourceStatus, selectMode,
  trivialConflictReason,
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

  // apiFetch used to `await desktopToken()` with no bound, and the promise is
  // memoized — so one stalled IPC reply hung every /api call for the life of
  // the session, with no error and no way back.
  it('gives up on a stalled token IPC and lets the next call ask again', async () => {
    // A fresh module: the token promise is memoized at module scope, and this
    // test is about what that memo does when the first request never settles.
    vi.resetModules()
    const fresh = await import('./api')
    vi.useFakeTimers()
    try {
      const getApiToken = vi.fn()
        .mockImplementationOnce(() => new Promise<string>(() => {})) // never settles
        .mockResolvedValue('second-try')
      window.__CC_DESKTOP = {
        getApiToken,
        version: '0.2.0',
        authState: { signedIn: false },
        cli: { getStatus: vi.fn(), install: vi.fn() },
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))

      const settled = expect(fresh.apiFetch('/api/graph')).rejects.toThrow(/API token/)
      await vi.advanceTimersByTimeAsync(fresh.TOKEN_TIMEOUT_MS + 10)
      await settled

      // The memo was dropped, so the session is not poisoned.
      await fresh.apiFetch('/api/graph')
      expect(getApiToken).toHaveBeenCalledTimes(2)
      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer second-try')
    } finally {
      vi.useRealTimers()
    }
  })

  // The main process answers `service?.token ?? ''`, so a service that is not
  // up yet resolves the IPC with an empty string. Memoizing that as a token
  // sent the rest of the session out unauthenticated against a service that
  // requires one — every call 401s, and nothing asks again.
  it('treats an empty token as a failed handover rather than memoizing it', async () => {
    vi.resetModules()
    const fresh = await import('./api')
    const getApiToken = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValue('real-token')
    window.__CC_DESKTOP = {
      getApiToken,
      version: '0.2.0',
      authState: { signedIn: false },
      cli: { getStatus: vi.fn(), install: vi.fn() },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))

    await expect(fresh.apiFetch('/api/graph')).rejects.toThrow(/empty API token/)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()

    await fresh.apiFetch('/api/graph')
    expect(getApiToken).toHaveBeenCalledTimes(2)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer real-token')
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

describe('mergeSourceStatus', () => {
  const base = (): Parameters<typeof mergeSourceStatus>[0] => adaptSources({
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
    sources: [{
      name: 'vault', level: 3, kind: 'files', conceptCount: 0, tokens: 0, latestUpdated: null,
      status: 'indexing', error: null,
      indexing: { status: 'indexing', phase: 'scanning', loaded: 0, total: null, elapsedMs: 100 },
    }],
    concepts: [],
  })

  const row = (patch: Record<string, unknown> = {}) => ([{
    name: 'vault', level: 3, kind: 'files', status: 'indexing', phase: 'loading',
    loaded: 1240, total: 3000, conceptCount: 0, refreshing: false, error: null, ...patch,
  }] as Parameters<typeof mergeSourceStatus>[1])

  // The row used to hold whatever the last heavy refetch said, so a Sources
  // list sat on the phase the source started in while the toolbar counted up.
  it('advances a source row from the cheap route alone', () => {
    const [before] = base()
    expect(before.focus).toContain('Scanning')
    const [after] = mergeSourceStatus(base(), row())
    expect(after.focus).toContain('1,240 / 3,000')
    expect(after.status).toBe('indexing')
    expect(after.coverage).toBe(41)
  })

  it('lands the row on a real count when the snapshot arrives', () => {
    const [done] = mergeSourceStatus(base(), row({ status: 'ok', phase: 'ready', loaded: 3000, conceptCount: 3000 }))
    expect(done.status).toBe('synced')
    expect(done.conceptCount).toBe(3000)
    expect(done.focus).toBe('3000 concepts · files')
  })

  it('returns the same array when nothing moved, so an idle poll costs no render', () => {
    const merged = mergeSourceStatus(base(), row())
    expect(mergeSourceStatus(merged, row())).toBe(merged)
  })

  it('leaves rows the status pass does not mention alone', () => {
    const sources = base()
    expect(mergeSourceStatus(sources, row({ name: 'somewhere-else' }))).toBe(sources)
  })
})

describe('adaptConcept with headingless documents', () => {
  // A plain note in a `files` layer — an Obsidian daily note with no `#` line —
  // resolves to one section with `heading: null`. The adapter called .replace on
  // that and took the whole page down; before this pass the store swallowed the
  // TypeError after three silent retries, so the app simply stopped updating.
  const headless: ResolvedConcept = {
    id: 'Daily Notes/2026-02-11',
    contributors: [{ layer: 'vault', level: 3, updated: '2026-02-11' }],
    frontmatter: { title: '2026-02-11', type: 'document' },
    sections: [{ key: 'body', heading: null, content: 'Talked to Priya.', sourceLayer: 'vault', sourceUpdated: '2026-02-11' }],
  }

  it('names a headingless section by its key instead of throwing', () => {
    const concept = adaptConcept(headless)
    expect(concept.sections[0].name).toBe('body')
  })

  it('derives a conflict title from a headingless section too', () => {
    const contested: ResolvedConcept = {
      ...headless,
      contributors: [...headless.contributors, { layer: 'team', level: 2, updated: '2026-02-10' }],
      sections: [{ ...headless.sections[0], conflicts: [{ layer: 'team', updated: '2026-02-10', content: 'Talked to Priya on Tuesday.' }] }],
    }
    const [conflict] = adaptConflicts([contested])
    expect(conflict.section).toBe('body')
    expect(conflict.title).toBe('body — 2026-02-11')
  })
})

describe('adaptSources', () => {
  // The field report, in one assertion: a 3,000-note vault fifteen seconds into
  // its first read rendered as "synced · 0 concepts". The app claimed to be
  // finished with work it had barely started, and there was nowhere to look.
  it('never renders an indexing source as synced, and never quotes its empty count', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
      indexing: true,
      indexingSources: ['vault'],
      sources: [{
        name: 'vault', level: 3, kind: 'files', conceptCount: 0, tokens: 0, latestUpdated: null,
        status: 'indexing', error: null,
        indexing: { status: 'indexing', phase: 'loading', loaded: 1240, total: 3000, elapsedMs: 8200 },
      }],
      concepts: [],
    }
    const [vault] = adaptSources(graph)
    expect(vault.status).toBe('indexing')
    expect(vault.status).not.toBe('synced')
    expect(vault.focus).toContain('1,240 / 3,000')
    expect(vault.focus).not.toContain('0 concepts')
    expect(vault.coverage).toBe(41)
    expect(vault.indexing).toEqual({ phase: 'loading', loaded: 1240, total: 3000, refreshing: false })
  })

  it('keeps a ready-but-refreshing source ready — it has an answer to serve', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 12, sources: 1 },
      sources: [{
        name: 'notes', level: 3, kind: 'files', conceptCount: 12, tokens: 0, latestUpdated: null,
        status: 'ok', error: null,
        indexing: { status: 'ready', phase: 'ready', loaded: 12, total: 12, elapsedMs: 40, refreshing: true },
      }],
      concepts: [],
    }
    const [notes] = adaptSources(graph)
    expect(notes.status).toBe('synced')
    expect(notes.coverage).toBe(100)
    expect(notes.focus).toContain('refreshing')
    expect(notes.indexing?.refreshing).toBe(true)
  })

  it('carries the true warning count, not the capped message list', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 3, sources: 1 },
      sources: [{
        name: 'vault', level: 3, kind: 'files', conceptCount: 3, tokens: 0, latestUpdated: null,
        status: 'ok', error: null,
        warnings: 43,
        warningMessages: Array.from({ length: 10 }, (_, i) => `skipped file-${i}.md`),
      }],
      concepts: [],
    }
    const [vault] = adaptSources(graph)
    expect(vault.warnings).toBe(43)
    expect(vault.warningMessages).toHaveLength(10)
  })

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
