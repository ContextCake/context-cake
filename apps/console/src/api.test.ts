// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adaptConcept, adaptConflicts, adaptDiscrepancies, adaptSources, apiFetch, computeLevelBuckets, isCompactRecord, LiveDataError, mergeSourceStatus,
  runSequentially, selectMode, trivialConflictReason,
} from './api'
import type { DiscrepancyRecord, GraphSummary, ResolvedConcept } from './types'

// The rank-based level→lane mapping (see computeLevelBuckets in api.ts) needs
// the full set of levels present across a resolve pass, not just the levels a
// single test concept happens to carry. Every fixture below uses the
// canonical trio of levels, so this single buckets value reproduces the old
// fixed-threshold mapping (0 → company, 2 → team, 3 → personal) exactly —
// tests that specifically exercise the rank behavior build their own.
const STANDARD_BUCKETS = computeLevelBuckets([0, 2, 3])

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

describe('LiveSource.search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns hits from /api/search on the happy path', async () => {
    const { createDataSource } = await import('./api')
    const hits = [{ id: 'decisions/primary-db', title: 'Primary database', score: 4.2, layers: ['team'], snippet: '...SingleStore for HTAP...' }]
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ hits }), { status: 200 }))
    const source = createDataSource('live')

    await expect(source.search('singlestore')).resolves.toEqual(hits)
    const [calledUrl] = vi.mocked(fetch).mock.calls[0]
    expect(String(calledUrl)).toBe('/api/search?q=singlestore&limit=20')
  })

  it('encodes the query and honors a custom limit', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ hits: [] }), { status: 200 }))
    const source = createDataSource('live')

    await source.search('primary db?', 5)
    const [calledUrl] = vi.mocked(fetch).mock.calls[0]
    expect(String(calledUrl)).toBe(`/api/search?q=${encodeURIComponent('primary db?')}&limit=5`)
  })

  // The existing older-engine-fallback idiom (see status() above): a 404
  // means this engine predates /api/search, and the signal is `null`, not a
  // thrown error — the caller (store.search) decides what to do with that.
  it('resolves to null on 404 — an engine older than this console', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response)
    const source = createDataSource('live')

    await expect(source.search('anything')).resolves.toBeNull()
  })

  it('rethrows a non-404 failure — only the 404 case is a silent fallback signal here', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const source = createDataSource('live')

    await expect(source.search('anything')).rejects.toMatchObject({ kind: 'bad-status', status: 500 })
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
})

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
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    expect(c.id).toBe('decisions/primary-db')
    expect(c.title).toBe('Primary database')
    expect(c.type).toBe('decision')
  })

  it('orders contributing layers by precedence (personal, team, company)', () => {
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    expect(c.layers).toEqual(['team', 'company'])
  })

  it('carries the real contributor source names, winner first — a zero-section concept has no section to read one from', () => {
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    expect(c.contributorLayers).toEqual(['team', 'company'])
    const empty: ResolvedConcept = { ...sample, sections: [] }
    expect(adaptConcept(empty, STANDARD_BUCKETS).contributorLayers).toEqual(['team', 'company'])
  })

  it('marks conflict true when any section has dissents', () => {
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    expect(c.conflict).toBe(true)
  })

  it('marks draft only from OKF frontmatter (write.mjs stamps auto-captures)', () => {
    const stamped: ResolvedConcept = { ...sample, frontmatter: { ...sample.frontmatter, draft: true } }
    expect(adaptConcept(stamped, STANDARD_BUCKETS).draft).toBe(true)
    expect(adaptConcept(sample, STANDARD_BUCKETS).draft).toBe(false)
    // A concept owned by a single layer is NOT draft — finished knowledge
    // commonly lives in exactly one layer.
    const solo: ResolvedConcept = { ...sample, contributors: [sample.contributors[0]], sections: [] }
    expect(adaptConcept(solo, STANDARD_BUCKETS).draft).toBe(false)
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
    const c = adaptConcept(custom, STANDARD_BUCKETS)
    expect(c.sections[0].winner).toBe('team')
    expect(c.layers).toEqual(['team', 'company'])
    const cards = adaptConflicts([custom], [], STANDARD_BUCKETS)
    expect(cards[0].winner).toBe('team')
    expect(cards[0].contributions[0].layer).toBe('team')
  })

  it('maps section winner, value, and provenance date', () => {
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    const s = c.sections[0]
    expect(s.name).toBe('Choice')
    expect(s.winner).toBe('team')
    expect(s.value).toBe('SingleStore for HTAP workloads.')
    expect(s.updated).toBe('2026-01-01')
  })

  it('surfaces dissenting layers on the section, not hidden', () => {
    const c = adaptConcept(sample, STANDARD_BUCKETS)
    const s = c.sections[0]
    expect(s.dissents).toHaveLength(1)
    expect(s.dissents?.[0]).toMatchObject({ layer: 'company', value: 'Postgres (org standard).', updated: '2025-06-01' })
  })

  it('marks a section suppressed when the engine flags override=none', () => {
    const suppressed: ResolvedConcept = {
      ...sample,
      sections: [{ ...sample.sections[0], suppressed: true, conflicts: undefined }],
    }
    const c = adaptConcept(suppressed, STANDARD_BUCKETS)
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

  // The detail block that says WHY a source failed is gated on `error`. This
  // pass moved `status` and left `error` behind, so a source that flipped to
  // error between heavy refetches rendered the word "error" and nothing else.
  it('carries the error text along with the status that needs explaining', () => {
    const [failed] = mergeSourceStatus(base(), row({ status: 'error', phase: 'error', error: 'ENOENT: /tmp/vault' }))
    expect(failed.status).toBe('error')
    expect(failed.error).toBe('ENOENT: /tmp/vault')
  })

  it('clears an error once the source reads cleanly again', () => {
    const failed = mergeSourceStatus(base(), row({ status: 'error', phase: 'error', error: 'ENOENT: /tmp/vault' }))
    const [ok] = mergeSourceStatus(failed, row({ status: 'ok', phase: 'ready', loaded: 3000, conceptCount: 3000 }))
    expect(ok.error).toBeNull()
  })

  // Warnings describe a snapshot. A failed read has none, so the "indexed with
  // N things left out" note must not hang over from the last good one.
  it('drops warnings from a row that no longer has a snapshot behind it', () => {
    const withWarnings = base().map((s) => ({ ...s, warnings: 2, warningMessages: ['too big: a.md', 'too big: b.md'] }))
    const [failed] = mergeSourceStatus(withWarnings, row({ status: 'error', phase: 'error', error: 'ENOENT' }))
    expect(failed.warnings).toBe(0)
    expect(failed.warningMessages).toBeUndefined()
  })

  // adaptSources normalizes a missing flag with `=== true`; this pass wrote it
  // raw. The two disagreeing on `undefined` vs `false` broke the identity
  // contract above, which is what makes an idle poll free.
  it('normalizes a missing refreshing flag the same way the graph adapter does', () => {
    const bare = row()
    delete (bare[0] as Partial<(typeof bare)[0]>).refreshing
    const merged = mergeSourceStatus(base(), bare)
    expect(merged[0].indexing?.refreshing).toBe(false)
    expect(mergeSourceStatus(merged, bare)).toBe(merged)
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
    const concept = adaptConcept(headless, STANDARD_BUCKETS)
    expect(concept.sections[0].name).toBe('body')
  })

  it('derives a conflict title from a headingless section too', () => {
    const contested: ResolvedConcept = {
      ...headless,
      contributors: [...headless.contributors, { layer: 'team', level: 2, updated: '2026-02-10' }],
      sections: [{ ...headless.sections[0], conflicts: [{ layer: 'team', updated: '2026-02-10', content: 'Talked to Priya on Tuesday.' }] }],
    }
    const [conflict] = adaptConflicts([contested], [], STANDARD_BUCKETS)
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

  // The fixed-threshold mapping this replaced sent any level < 2 straight to
  // 'company' — so a level-1 source sat in Company next to level 0, and the
  // Team lane, with nothing at level 2, sat empty. Ranked among the levels
  // that actually exist (3 and 1 here), level 1 is the *second* highest and
  // now lands in 'team'.
  it('ranks a level-1 source into team, not company, when a higher level exists', () => {
    const graph: GraphSummary = {
      totals: { sourceTokens: 10, resolvedTokens: 10, concepts: 2, sources: 2 },
      sources: [
        { name: 'personal', level: 3, kind: 'okf-local', conceptCount: 1, tokens: 10, latestUpdated: null, status: 'ok', error: null },
        { name: 'messy-vault', level: 1, kind: 'files', conceptCount: 1, tokens: 10, latestUpdated: null, status: 'ok', error: null },
      ],
      concepts: [],
    }
    const [, vault] = adaptSources(graph)
    expect(vault.name).toBe('messy-vault')
    expect(vault.layer).toBe('team')
    expect(vault.layer).not.toBe('company')
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
    const out = adaptConflicts(concepts, [], STANDARD_BUCKETS)
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
    expect(adaptConflicts(concepts, [], STANDARD_BUCKETS)).toEqual([])
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
    }], STANDARD_BUCKETS)

    expect(resolved.status).toBe('resolved')
    expect(resolved.winner).toBe('team')
    expect(resolved.contributions.map((item) => item.layer)).toEqual(['team', 'company'])
    // F13 prerequisite: a resolved card carries the winning source directly,
    // so the Conflicts source filter can match it even when the contributions
    // snapshot it carries doesn't happen to include that source by name.
    expect(resolved.effectiveSource).toBe('acme-eng')
  })
})

describe('adaptDiscrepancies', () => {
  function frontmatterRecord(overrides: Partial<DiscrepancyRecord> = {}): DiscrepancyRecord {
    return {
      id: 'frontmatter_value::decisions/primary-db::tags',
      kind: 'frontmatter_value',
      originalKind: 'frontmatter_value',
      conceptId: 'decisions/primary-db',
      conceptTitle: 'Primary database',
      conceptType: 'concept',
      key: 'tags',
      label: 'tags',
      revision: 'rev-1',
      status: 'needs_review',
      contributions: [
        { source: 'team', level: 2, updated: '2026-01-01', value: 'oltp', fingerprint: 'fp1', effective: true },
        { source: 'company', level: 0, updated: '2025-01-01', value: 'oltp', fingerprint: 'fp2', effective: false },
      ],
      effectiveSource: 'team',
      effectiveValue: 'oltp',
      winnerReason: 'team wins by configured layer precedence.',
      owner: 'Unassigned',
      priority: 'unassigned',
      fresherDissent: false,
      freshness: { effectiveUpdated: '2026-01-01', newestUpdated: '2026-01-01', hasNewerDissent: false },
      affectedLinks: [],
      sourceHealth: [],
      history: [],
      matchingRules: [],
      ...overrides,
    }
  }

  it('flags a discrepancy isList when any raw contribution value is an array — the engine 400s compose against it', () => {
    const record = frontmatterRecord({
      contributions: [
        { source: 'team', level: 2, updated: '2026-01-01', value: ['postgres', 'oltp'], fingerprint: 'fp1', effective: true },
        { source: 'company', level: 0, updated: '2025-01-01', value: ['mysql'], fingerprint: 'fp2', effective: false },
      ],
    })
    const [card] = adaptDiscrepancies([record], true, STANDARD_BUCKETS)
    expect(card.isList).toBe(true)
    // The display value is still the honest stringified form, never the raw array.
    expect(card.contributions[0].value).toBe(JSON.stringify(['postgres', 'oltp'], null, 2))
  })

  it('never flags isList for an ordinary string-valued frontmatter field', () => {
    const [card] = adaptDiscrepancies([frontmatterRecord()], true, STANDARD_BUCKETS)
    expect(card.isList).toBeUndefined()
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
    const c = adaptConcept(conflicted({ fresherDissent: true }), STANDARD_BUCKETS)
    expect(c.sections[0].fresherDissent).toBe(true)
    expect(adaptConcept(conflicted({}), STANDARD_BUCKETS).sections[0].fresherDissent).toBeUndefined()
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
    const [card] = adaptConflicts([concept], [], STANDARD_BUCKETS)
    expect(card.contributions[0].fresherDissent).toBeUndefined() // the winner is never its own dissent
    expect(card.contributions[1]).toMatchObject({ layer: 'team', fresherDissent: true })
    expect(card.contributions[2].fresherDissent).toBeUndefined() // older dissent stays unmarked
  })

  it('never marks a dissent when the engine did not flag the section', () => {
    // The engine owns the rule (it also knows about suppression and
    // formatting-equivalence); the console must not out-guess it.
    const [card] = adaptConflicts([conflicted({})], [], STANDARD_BUCKETS)
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
    const [card] = adaptConflicts([concept], [], STANDARD_BUCKETS)
    expect(card.contributions[1].fresherDissent).toBeUndefined()
    expect(card.contributions[2].fresherDissent).toBe(true)
  })

  it('never treats a missing or unparseable date as epoch 0', () => {
    const concept = conflicted({
      fresherDissent: true,
      sourceUpdated: null,
      conflicts: [{ layer: 'team', updated: '2026-06-01', content: 'Dated dissent.' }],
    })
    const [card] = adaptConflicts([concept], [], STANDARD_BUCKETS)
    expect(card.contributions[1].fresherDissent).toBeUndefined()

    const garbled = conflicted({
      fresherDissent: true,
      conflicts: [{ layer: 'team', updated: 'not-a-date', content: 'Undated dissent.' }],
    })
    expect(adaptConflicts([garbled], [], STANDARD_BUCKETS)[0].contributions[1].fresherDissent).toBeUndefined()
  })
})

// ---- Discrepancy Center wire: compact rows, detail, batch -------------------

describe('adaptDiscrepancy: compact vs full records', () => {
  const full: DiscrepancyRecord = {
    id: 'broken_link::notes/a::body::decisions/Old', kind: 'broken_link', originalKind: 'broken_link',
    conceptId: 'notes/a', conceptTitle: 'Note A', conceptType: 'note', key: 'body', label: 'Body', target: 'decisions/Old',
    revision: 'rev-1', status: 'needs_review',
    contributions: [{ source: 'personal', level: 3, updated: '2026-01-01', value: 'decisions/Old', fingerprint: 'fp', effective: true }],
    effectiveSource: 'personal', effectiveValue: 'decisions/Old', winnerReason: 'personal wins.', owner: 'Unassigned', priority: 'unassigned',
    fresherDissent: false, freshness: { effectiveUpdated: null, newestUpdated: null, hasNewerDissent: false },
    affectedLinks: [], sourceHealth: [], history: [], matchingRules: [],
    candidates: [{ id: 'decisions/old', reason: 'case', confidence: 0.95 }],
    bestCandidate: { id: 'decisions/old', reason: 'case', confidence: 0.95 },
  }
  const compact: DiscrepancyRecord = {
    ...full, history: undefined,
    contributions: [{ ...full.contributions[0], truncated: false, valueBytes: 13, valueKind: 'string' }],
    historyCount: 2, latestDecision: { id: 'd2', action: 'acknowledge', decidedAt: '2026-02-02', transactionState: 'not_required' }, compact: true,
  }

  it('marks a compact row detailLoaded:false with its history stand-ins, and a full record not at all', () => {
    expect(isCompactRecord(compact)).toBe(true)
    expect(isCompactRecord(full)).toBe(false)
    const [row] = adaptDiscrepancies([compact], true, STANDARD_BUCKETS)
    expect(row.detailLoaded).toBe(false)
    expect(row.historyCount).toBe(2)
    expect(row.latestDecision?.action).toBe('acknowledge')
    expect(row.history).toEqual([])
    const [fullRow] = adaptDiscrepancies([full], true, STANDARD_BUCKETS)
    expect(fullRow.detailLoaded).toBeUndefined()
    expect(fullRow.historyCount).toBeUndefined()
  })

  it('carries the broken-link candidates, the concept title/type, and a truncated preview flag', () => {
    const [row] = adaptDiscrepancies([{ ...compact, contributions: [{ ...compact.contributions[0], value: 'decisions/Ol…', truncated: true, valueBytes: 400 }] }], true, STANDARD_BUCKETS)
    expect(row.candidates).toEqual([{ id: 'decisions/old', reason: 'case', confidence: 0.95 }])
    expect(row.bestCandidate?.id).toBe('decisions/old')
    expect(row.conceptTitle).toBe('Note A')
    expect(row.conceptType).toBe('note')
    expect(row.contributions[0].truncated).toBe(true)
    // A compact list-valued field is already text; `valueKind` is what still says it was a list.
    const [listRow] = adaptDiscrepancies([{ ...compact, kind: 'frontmatter_value', contributions: [{ ...compact.contributions[0], value: '["a","b"]', valueKind: 'list' }] }], true, STANDARD_BUCKETS)
    expect(listRow.isList).toBe(true)
  })

  it('a compact record with a truncated flag alone is still recognized (the `compact` marker is belt and braces)', () => {
    const { compact: _flag, ...withoutMarker } = compact
    expect(isCompactRecord(withoutMarker as DiscrepancyRecord)).toBe(true)
  })
})

describe('LiveSource discrepancy routes', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const status = (code: number, body: unknown = {}) => ({ ok: code < 400, status: code, json: async () => body, clone() { return this } }) as unknown as Response
  const url = (call: unknown[]) => String(call[0])
  const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body))

  it('asks for compact rows, and reads the summary envelope', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue(okJson({ discrepancies: [], summary: { total: 0 }, coverageComplete: true, indexing: false, indexingSources: [], errors: [], generation: 4, projectionRevision: 'p1' }))
    const out = await createDataSource('live').discrepancies()
    expect(url(vi.mocked(fetch).mock.calls[0])).toBe('/api/discrepancies?fields=compact')
    expect(out?.summary).toEqual({ total: 0 })
    expect(out?.projectionRevision).toBe('p1')
  })

  it('answers null for an engine without the discrepancies route at all', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue(status(404))
    expect(await createDataSource('live').discrepancies()).toBeNull()
  })

  it('reads one full record through ?id=, and picks it out of the list an older engine answers instead', async () => {
    const { createDataSource } = await import('./api')
    const record = { id: 'x::1', history: [{ id: 'd1' }] }
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ discrepancy: record, generation: 1 }))
    expect(await createDataSource('live').discrepancyDetail('x::1')).toEqual(record)
    expect(url(vi.mocked(fetch).mock.calls[0])).toBe('/api/discrepancies?id=x%3A%3A1')

    vi.mocked(fetch).mockResolvedValueOnce(okJson({ discrepancies: [{ id: 'other' }, record], coverageComplete: true }))
    expect(await createDataSource('live').discrepancyDetail('x::1')).toEqual(record)

    vi.mocked(fetch).mockResolvedValueOnce(okJson({ discrepancy: null, generation: 2 }))
    expect(await createDataSource('live').discrepancyDetail('gone')).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(status(404))
    expect(await createDataSource('live').discrepancyDetail('x::1')).toBeNull()
  })

  it('posts a batch to the batch route and carries the engine answer through', async () => {
    const { createDataSource } = await import('./api')
    const answer = { ok: true, applied: 2, failed: 0, notAttempted: 0, dryRun: true, results: [{ discrepancyId: 'a', ok: true }, { discrepancyId: 'b', ok: true }], suggestions: [{ id: 's1' }] }
    vi.mocked(fetch).mockResolvedValue(okJson(answer))
    const request = { decisions: [{ discrepancyId: 'a', revision: '1', action: 'acknowledge' as const }, { discrepancyId: 'b', revision: '1', action: 'unlink' as const }], dryRun: true }
    const out = await createDataSource('live').decideDiscrepancies(request)
    expect(url(vi.mocked(fetch).mock.calls[0])).toBe('/api/discrepancy-decisions/batch')
    expect(bodyOf(vi.mocked(fetch).mock.calls[0])).toEqual(request)
    expect(out).toMatchObject(answer)
  })

  it('sends a selection past the 500-decision ceiling as consecutive batches and merges the answers in order', async () => {
    const { createDataSource, BATCH_LIMIT } = await import('./api')
    expect(BATCH_LIMIT).toBe(500)
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { decisions: { discrepancyId: string }[] }
      return okJson({
        ok: true, applied: body.decisions.length, failed: 0, notAttempted: 0, dryRun: false,
        results: body.decisions.map((decision) => ({ discrepancyId: decision.discrepancyId, ok: true })),
        suggestions: [{ id: `after-${body.decisions[body.decisions.length - 1].discrepancyId}` }],
      })
    })
    const decisions = Array.from({ length: 1201 }, (_, index) => ({ discrepancyId: `d${index}`, revision: '1', action: 'unlink' as const }))
    const out = await createDataSource('live').decideDiscrepancies({ decisions })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetch).mock.calls.map((call) => bodyOf(call).decisions.length)).toEqual([500, 500, 201])
    expect(out.applied).toBe(1201)
    expect(out.results).toHaveLength(1201)
    expect(out.results[0].discrepancyId).toBe('d0')
    expect(out.results[1200].discrepancyId).toBe('d1200')
    expect(out.ok).toBe(true)
    // Suggestions merge across batches by id (each batch mines the whole log).
    expect(out.suggestions?.map((suggestion) => suggestion.id)).toEqual(['after-d499', 'after-d999', 'after-d1200'])
  })

  it('falls back to one decision at a time when the batch route is missing, and says so', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/discrepancy-decisions/batch') return status(404, { error: 'Not found' })
      const body = JSON.parse(String(init?.body))
      if (body.discrepancyId === 'b') return status(409, { error: 'The record changed since you loaded it.', code: 'STALE' })
      return okJson({ decision: { id: `dec-${body.discrepancyId}`, writtenTargets: [{ layer: 'personal', path: 'x.md' }] } })
    })
    const out = await createDataSource('live').decideDiscrepancies({
      decisions: [
        { discrepancyId: 'a', revision: '1', action: 'acknowledge', reasonCode: 'other' },
        { discrepancyId: 'b', revision: '1', action: 'acknowledge', reasonCode: 'other' },
        { discrepancyId: 'c', revision: '1', action: 'acknowledge', reasonCode: 'other' },
      ],
    })
    expect(out.fallback).toBe('sequential')
    expect(out.applied).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.ok).toBe(false)
    expect(out.results.map((result) => [result.discrepancyId, result.ok])).toEqual([['a', true], ['b', false], ['c', true]])
    expect(out.results[0].decision?.id).toBe('dec-a')
    expect(out.results[0].written).toEqual([{ layer: 'personal', path: 'x.md' }])
    expect(out.results[1]).toMatchObject({ status: 409, code: 'STALE', error: 'The record changed since you loaded it.' })
    // One batch attempt, then one single per decision.
    expect(vi.mocked(fetch).mock.calls.map(url)).toEqual(['/api/discrepancy-decisions/batch', '/api/discrepancy-decisions', '/api/discrepancy-decisions', '/api/discrepancy-decisions'])
  })

  it('keeps what earlier batches applied when a later batch is refused, and reports the rest not attempted', async () => {
    const { createDataSource } = await import('./api')
    let calls = 0
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as { decisions: { discrepancyId: string }[] }
      if (calls === 2) return status(409, { error: 'Coverage is incomplete while sources index.', code: 'COVERAGE_INCOMPLETE' })
      return okJson({
        ok: true, applied: body.decisions.length, failed: 0, notAttempted: 0, dryRun: false,
        results: body.decisions.map((decision) => ({ discrepancyId: decision.discrepancyId, ok: true })),
        suggestions: [{ id: 's-shared' }, { id: `s-${calls}` }],
      })
    })
    const decisions = Array.from({ length: 600 }, (_, index) => ({ discrepancyId: `d${index}`, revision: '1', action: 'unlink' as const }))
    const out = await createDataSource('live').decideDiscrepancies({ decisions })
    expect(calls).toBe(2)
    expect(out.applied).toBe(500)
    expect(out.notAttempted).toBe(100)
    expect(out.failed).toBe(0)
    expect(out.ok).toBe(false)
    expect(out.error).toMatchObject({ chunk: 2, status: 409, code: 'COVERAGE_INCOMPLETE' })
    expect(out.results).toHaveLength(600)
    expect(out.results[499]).toMatchObject({ discrepancyId: 'd499', ok: true })
    expect(out.results[500]).toMatchObject({ discrepancyId: 'd500', ok: false, code: 'SKIPPED' })
    expect(out.results[500].error).toContain('batch 2 of 2 was refused')
    // Suggestions merge by id across batches rather than the last one winning.
    expect(out.suggestions?.map((suggestion) => suggestion.id)).toEqual(['s-shared', 's-1'])
  })

  it('stops sending further batches once one reports RECOVERY_REQUIRED, regardless of stopOnError', async () => {
    const { createDataSource } = await import('./api')
    let calls = 0
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as { decisions: { discrepancyId: string }[] }
      return okJson({
        ok: false, applied: 1, failed: 1, notAttempted: body.decisions.length - 2, dryRun: false,
        results: body.decisions.map((decision, index) => (index === 0
          ? { discrepancyId: decision.discrepancyId, ok: true }
          : index === 1
            ? { discrepancyId: decision.discrepancyId, ok: false, status: 409, code: 'RECOVERY_REQUIRED', error: 'A previous write needs recovery.' }
            : { discrepancyId: decision.discrepancyId, ok: false, status: 409, code: 'SKIPPED', error: 'Skipped: an earlier write in this batch requires recovery.' })),
        suggestions: [],
      })
    })
    const decisions = Array.from({ length: 600 }, (_, index) => ({ discrepancyId: `d${index}`, revision: '1', action: 'unlink' as const }))
    const out = await createDataSource('live').decideDiscrepancies({ decisions })
    expect(calls).toBe(1)
    expect(out.applied).toBe(1)
    expect(out.notAttempted).toBe(598)
    expect(out.results[599]).toMatchObject({ discrepancyId: 'd599', ok: false, code: 'SKIPPED' })
    expect(out.results[599].error).toContain('requires recovery')
  })

  it('does not fall back on a real refusal — a 409 from the batch route is an answer, with its code', async () => {
    const { createDataSource } = await import('./api')
    vi.mocked(fetch).mockResolvedValue(status(409, { error: 'Coverage is incomplete while sources index.', code: 'COVERAGE_INCOMPLETE' }))
    await expect(createDataSource('live').decideDiscrepancies({ decisions: [{ discrepancyId: 'a', revision: '1', action: 'unlink' }] }))
      .rejects.toMatchObject({ status: 409, code: 'COVERAGE_INCOMPLETE' })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('a sequential dry run makes no request and carries no wouldWrite', async () => {
    const decide = vi.fn()
    const out = await runSequentially({ dryRun: true, decisions: [{ discrepancyId: 'a', revision: '1', action: 'unlink' }] }, decide)
    expect(decide).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, applied: 0, failed: 0, fallback: 'sequential', results: [{ discrepancyId: 'a', ok: true }] })
    expect(out.results[0].wouldWrite).toBeUndefined()
  })

  it('stopOnError ends the sequential loop at the first failure and reports the tail as SKIPPED (not attempted)', async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue({ id: 'ok' })
    const out = await runSequentially({ stopOnError: true, decisions: [{ discrepancyId: 'a', revision: '1', action: 'unlink' }, { discrepancyId: 'b', revision: '1', action: 'unlink' }] }, decide)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(out.results).toHaveLength(2)
    expect(out.failed).toBe(1)
    expect(out.notAttempted).toBe(1)
    expect(out.results[1]).toMatchObject({ discrepancyId: 'b', ok: false, code: 'SKIPPED', status: 409 })
    expect(out.ok).toBe(false)
  })
})

describe('DemoSource discrepancy simulation', () => {
  it('runs a batch through the single-decision simulation and moves acknowledged rows to Acknowledged on the next read', async () => {
    const { createDataSource } = await import('./api')
    const source = createDataSource('demo')
    const before = await source.discrepancies()
    const first = before!.discrepancies[0]
    expect(first.status).toBe('needs_review')
    const out = await source.decideDiscrepancies({ decisions: [{ discrepancyId: first.id, revision: first.revision, action: 'acknowledge', reasonCode: 'other' }] })
    expect(out.applied).toBe(1)
    expect(out.results[0].decision?.action).toBe('acknowledge')
    const after = await source.discrepancies()
    expect(after!.discrepancies.find((item) => item.id === first.id)?.status).toBe('acknowledged')
    // The detail route is the same record.
    expect((await source.discrepancyDetail(first.id))?.id).toBe(first.id)
    expect(await source.discrepancyDetail('nope')).toBeNull()
  })
})
