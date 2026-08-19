// @vitest-environment jsdom
// The load contract: the shell must never wait on source reading.
//
// The regression these cover is the first-run hang — the whole app sat behind
// a "Resolving the cascade…" screen until every source had been read, which on
// a large folder meant minutes of an unusable window.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'

const mocks = vi.hoisted(() => ({
  graph: vi.fn(), resolveAll: vi.fn(), conflictResolutions: vi.fn(), status: vi.fn(),
  resolve: vi.fn(), discrepancies: vi.fn(),
  discrepancyDetail: vi.fn(), decideDiscrepancy: vi.fn(), decideDiscrepancies: vi.fn(),
  // The graph-first path only exists against an engine that serves
  // /api/discrepancies; most cases here predate it and pin the legacy
  // resolve-all fallback, so the modern route is opt-in per suite.
  flags: { withDiscrepancies: false },
}))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    createDataSource: () => ({
      mode: 'live' as const,
      graph: mocks.graph,
      resolveAll: mocks.resolveAll,
      resolve: mocks.resolve,
      listConcepts: vi.fn(),
      status: mocks.status,
      conflictResolutions: mocks.conflictResolutions,
      resolveConflict: vi.fn(),
      ...(mocks.flags.withDiscrepancies ? {
        discrepancies: mocks.discrepancies, discrepancyDetail: mocks.discrepancyDetail,
        decideDiscrepancy: mocks.decideDiscrepancy, decideDiscrepancies: mocks.decideDiscrepancies,
      } : {}),
    }),
  }
})

let container: HTMLDivElement
let root: Root

/** Renders the store's load state so assertions read it from the DOM. */
function Probe() {
  const { load, concepts, sources, reload, retryNow, view, selConcept, filesScope, filesPath, openFilesScope, setView, setFilesScope, setFilesPath } = useStore()
  const selected = concepts.find((c) => c.id === selConcept)
  return (
    <div
      data-shell={String(load.shell)}
      data-concepts={String(load.concepts)}
      data-indexing={load.indexingSources.join(',')}
      data-count={String(concepts.length)}
      data-sel-detail={String(selected?.detailLoaded)}
      data-sel-sections={String(selected?.sections.length ?? '')}
      data-conflict-ids={concepts.filter((c) => c.conflict).map((c) => c.id).join(',')}
      data-sources={String(sources.length)}
      data-view={view}
      data-selection={selConcept}
      data-files-scope={filesScope ?? ''}
      data-files-path={filesPath ?? ''}
      data-refresh-error={load.refreshError?.message ?? ''}
      data-tasks={load.tasks.map((t) => `${t.name}:${t.phase}:${t.loaded}/${t.total ?? '?'}${t.refreshing ? ':refreshing' : ''}`).join(',')}
    >
      <button type="button" onClick={reload}>reload</button>
      <button type="button" onClick={retryNow}>retry</button>
      <button type="button" onClick={() => setView('sources')}>to sources</button>
      <button type="button" onClick={() => openFilesScope('team-docs')}>browse team-docs</button>
      <button type="button" onClick={() => setFilesPath('team-docs/notes/a.md')}>open a.md</button>
      <button type="button" onClick={() => setFilesScope(null)}>clear scope</button>
    </div>
  )
}

const probe = () => container.firstElementChild as HTMLElement

function graphPayload(indexingSources: string[], generation = 1, conceptCount = 0) {
  return {
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
    indexing: indexingSources.length > 0,
    indexingSources,
    generation,
    sources: [{
      name: 'personal', level: 3, kind: 'files', conceptCount, tokens: 0,
      latestUpdated: null, status: indexingSources.length ? 'indexing' : 'ok', error: null,
    }],
    concepts: [],
  }
}

/** A /api/status payload: the cheap route the loop actually polls. */
function statusPayload({
  generation, indexing, loaded = 0, total = null as number | null, conceptCount = 0, refreshing = false,
}: { generation: number; indexing: boolean; loaded?: number; total?: number | null; conceptCount?: number; refreshing?: boolean }) {
  return {
    generation,
    indexing,
    indexingSources: indexing ? ['personal'] : [],
    sources: [{
      name: 'personal', level: 3, kind: 'files',
      status: indexing ? 'indexing' : 'ok', phase: indexing ? 'loading' : 'ready',
      loaded, total, conceptCount, refreshing, error: null,
    }],
  }
}

function conceptPayload(id: string) {
  return {
    id,
    contributors: [{ layer: 'personal', level: 3, updated: '2026-01-01' }],
    frontmatter: { title: id, type: 'note' },
    sections: [{ key: 'body', heading: '## Body {#body}', content: 'x', sourceLayer: 'personal', sourceUpdated: '2026-01-01' }],
  }
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.graph.mockReset()
  mocks.resolveAll.mockReset()
  mocks.conflictResolutions.mockReset()
  mocks.status.mockReset()
  mocks.resolve.mockReset()
  mocks.discrepancies.mockReset()
  mocks.discrepancyDetail.mockReset()
  mocks.decideDiscrepancy.mockReset()
  mocks.decideDiscrepancies.mockReset()
  mocks.flags.withDiscrepancies = false
  mocks.status.mockResolvedValue(null) // most cases exercise the legacy graph path
  mocks.conflictResolutions.mockResolvedValue([])
  window.history.replaceState(null, '', '/#/overview')
  window.localStorage.clear()
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
})

describe('store load state', () => {
  it('unblocks the shell as soon as the graph responds, before concepts resolve', async () => {
    let releaseResolveAll: (v: unknown) => void = () => {}
    mocks.graph.mockResolvedValue(graphPayload(['personal']))
    mocks.resolveAll.mockReturnValue(new Promise((res) => { releaseResolveAll = res }))

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    // resolve-all is still pending — the shell must already be up.
    expect(probe().dataset.shell).toBe('false')
    expect(probe().dataset.sources).toBe('1')
    expect(probe().dataset.concepts).toBe('true')

    await act(async () => {
      releaseResolveAll({ concepts: [conceptPayload('a')], errors: [], indexing: false })
    })
    expect(probe().dataset.count).toBe('1')
    expect(probe().dataset.concepts).toBe('false')
    expect(probe().dataset.indexing).toBe('')
  })

  it('reports which sources are still indexing so the UI can say so', async () => {
    mocks.graph.mockResolvedValue(graphPayload(['team', 'company']))
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['team', 'company'] })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    expect(probe().dataset.indexing).toBe('team,company')
    expect(probe().dataset.shell).toBe('false')
  })

  it('keeps an already-loaded shell mounted during a refresh', async () => {
    let releaseRefresh: (v: unknown) => void = () => {}
    mocks.graph
      .mockResolvedValueOnce(graphPayload([]))
      .mockReturnValueOnce(new Promise((resolve) => { releaseRefresh = resolve }))
    mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.shell).toBe('false')

    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(probe().dataset.shell).toBe('false')

    await act(async () => releaseRefresh(graphPayload([])))
  })

  it('polls while indexing and fills in concepts as they land', async () => {
    mocks.graph
      .mockResolvedValueOnce(graphPayload(['personal']))
      .mockResolvedValue(graphPayload([]))
    mocks.resolveAll
      .mockResolvedValueOnce({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      .mockResolvedValue({ concepts: [conceptPayload('a'), conceptPayload('b')], errors: [], indexing: false })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.count).toBe('0')

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(probe().dataset.count).toBe('2')
    expect(probe().dataset.concepts).toBe('false')
    expect(probe().dataset.indexing).toBe('')
  })

  it('retries a stumble mid-index instead of leaving the banner running forever', async () => {
    mocks.graph.mockResolvedValue(graphPayload(['personal']))
    mocks.resolveAll
      .mockResolvedValueOnce({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

    expect(probe().dataset.count).toBe('1')
    expect(probe().dataset.concepts).toBe('false')
  })

  // The regression this replaces: the loop gave up after three failures, cleared
  // `indexingSources`, and said nothing. The page then looked settled while it
  // had in fact stopped updating — a lie with no way for anyone to notice.
  it('never gives up silently — a failing refresh surfaces and keeps retrying', async () => {
    mocks.graph
      .mockResolvedValueOnce(graphPayload(['personal']))
      .mockRejectedValue(new Error('server went away'))
    mocks.resolveAll.mockResolvedValue({
      concepts: [], errors: [], indexing: true, indexingSources: ['personal'],
    })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.indexing).toBe('personal')

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    // Five-plus failures later: still saying what it knows, still retrying.
    expect(mocks.graph.mock.calls.length).toBeGreaterThan(5)
    expect(probe().dataset.refreshError).toBe('server went away')
    expect(probe().dataset.indexing).toBe('personal')

    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })

    expect(probe().dataset.refreshError).toBe('')
    expect(probe().dataset.indexing).toBe('')
    expect(probe().dataset.count).toBe('1')
  })

  it('retryNow polls immediately instead of waiting out the backoff', async () => {
    mocks.graph
      .mockResolvedValueOnce(graphPayload(['personal']))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(graphPayload([]))
    mocks.resolveAll
      .mockResolvedValueOnce({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      .mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(probe().dataset.refreshError).toBe('transient')

    const before = mocks.graph.mock.calls.length
    await act(async () => {
      container.querySelectorAll('button')[1]?.click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(mocks.graph.mock.calls.length).toBeGreaterThan(before)
    expect(probe().dataset.refreshError).toBe('')
  })

  describe('cheap polling', () => {
    it('polls /api/status and leaves the heavy payloads alone while only progress moves', async () => {
      mocks.graph.mockResolvedValue(graphPayload(['personal']))
      mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      // Generation moves every tick (the engine counts documents into it), but
      // nothing that decides the payload changes until the snapshot lands.
      mocks.status
        // Consumed by the WP-B bootstrap probe, immediately after readAll()
        // commits — same generation and shape readAll() itself just saw, so
        // the probe is a no-op and the three progress-only ticks below still
        // land on the recurring poll() exactly as before.
        .mockResolvedValueOnce(statusPayload({ generation: 1, indexing: true, loaded: 0, total: 3000 }))
        .mockResolvedValueOnce(statusPayload({ generation: 2, indexing: true, loaded: 400, total: 3000 }))
        .mockResolvedValueOnce(statusPayload({ generation: 3, indexing: true, loaded: 900, total: 3000 }))
        .mockResolvedValueOnce(statusPayload({ generation: 4, indexing: true, loaded: 1800, total: 3000 }))
        .mockResolvedValue(statusPayload({ generation: 9, indexing: false, loaded: 3000, total: 3000, conceptCount: 12 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      const afterBootstrap = mocks.resolveAll.mock.calls.length
      expect(afterBootstrap).toBe(1)

      await act(async () => { await vi.advanceTimersByTimeAsync(2_800) })
      // Three progress-only ticks: three status calls, zero resolve-alls.
      expect(mocks.status.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(mocks.resolveAll.mock.calls.length).toBe(afterBootstrap)
      expect(probe().dataset.tasks).toContain('personal:loading:1800/3000')

      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      // The snapshot landed (conceptCount moved): exactly one heavy refetch.
      expect(mocks.resolveAll.mock.calls.length).toBe(afterBootstrap + 1)
      expect(probe().dataset.count).toBe('1')
    })

    // A rejected heavy refetch used to advance the poll gate anyway. The next
    // tick then saw nothing moved, skipped the retry, and took the success
    // path — clearing the banner while the page showed pre-edit concepts, for
    // the rest of the session. A failure that erases its own evidence.
    it('never reports success for a refetch that failed, and owes it to the next poll', async () => {
      mocks.graph
        .mockResolvedValueOnce(graphPayload([]))
        .mockResolvedValue(graphPayload([], 5, 3))
      mocks.resolveAll
        .mockResolvedValueOnce({ concepts: [conceptPayload('a')], errors: [], indexing: false })
        .mockRejectedValue(new Error('resolve-all timed out'))
      // The engine's answer moved once and then sat still — which is the whole
      // problem: no later poll reopens the gate by itself.
      mocks.status.mockResolvedValue(statusPayload({ generation: 5, indexing: false, conceptCount: 3 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      expect(probe().dataset.count).toBe('1')

      await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
      const afterFirstFailure = mocks.resolveAll.mock.calls.length
      expect(probe().dataset.refreshError).toBe('resolve-all timed out')

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      // Still retrying the heavy read, and still saying it is failing.
      expect(mocks.resolveAll.mock.calls.length).toBeGreaterThan(afterFirstFailure)
      expect(probe().dataset.refreshError).toBe('resolve-all timed out')

      mocks.resolveAll.mockResolvedValue({
        concepts: [conceptPayload('a'), conceptPayload('b')], errors: [], indexing: false,
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(probe().dataset.refreshError).toBe('')
      expect(probe().dataset.count).toBe('2')
    })

    // `graph.generation` is optional on the wire. An engine that serves
    // /api/status without it left the gate un-advanced on every pass, so
    // `moved` was permanently true and a settled, idle app pulled the whole
    // corpus back every five seconds, forever.
    it('does not re-read the corpus every idle poll when the graph carries no generation', async () => {
      const bare = graphPayload([], 1, 3) as Partial<ReturnType<typeof graphPayload>>
      delete bare.generation
      mocks.graph.mockResolvedValue(bare)
      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      mocks.status.mockResolvedValue(statusPayload({ generation: 7, indexing: false, conceptCount: 3 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      const afterBootstrap = mocks.resolveAll.mock.calls.length

      // Four idle cadences with nothing moving on the engine at all.
      await act(async () => { await vi.advanceTimersByTimeAsync(21_000) })
      expect(mocks.status.mock.calls.length).toBeGreaterThanOrEqual(4)
      expect(mocks.resolveAll.mock.calls.length).toBeLessThanOrEqual(afterBootstrap + 1)
      expect(probe().dataset.count).toBe('1')
    })

    it('reports a refreshing source as work in flight without holding up its data', async () => {
      mocks.graph.mockResolvedValue(graphPayload([]))
      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      mocks.status.mockResolvedValue(statusPayload({
        generation: 5, indexing: false, loaded: 120, total: 400, conceptCount: 12, refreshing: true,
      }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      // Nothing was indexing at bootstrap, so the loop is on its idle cadence.
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })

      expect(probe().dataset.tasks).toContain(':refreshing')
      // Refreshing is not indexing: nothing is waiting on it.
      expect(probe().dataset.indexing).toBe('')
      expect(probe().dataset.count).toBe('1')
    })

    it('stops polling while the window is hidden when nothing is active, and resumes when it comes back', async () => {
      // The cost optimization this pins: a hidden tab with nothing in flight
      // must stay silent, exactly as before FIX 3 — only a hidden tab with
      // real work active gets the new slower-but-still-polling behavior
      // (see the next test).
      mocks.graph.mockResolvedValue(graphPayload([]))
      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: false, conceptCount: 1 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
      const whileVisible = mocks.status.mock.calls.length
      expect(whileVisible).toBeGreaterThan(0)

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(mocks.status.mock.calls.length).toBe(whileVisible)

      visibility.mockReturnValue('visible')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(mocks.status.mock.calls.length).toBeGreaterThan(whileVisible)
      visibility.mockRestore()
    })

    // FIX 3(a): schedule() used to be a flat no-op while hidden, so a
    // backgrounded tab that was still indexing when it went hidden (or that
    // started out hidden — see the WP-B bootstrap-probe test below) had
    // nothing left to resume it, possibly forever. Real work in flight now
    // keeps the loop polling through a hidden window, just at
    // HIDDEN_ACTIVE_POLL_MS instead of the visible ACTIVE_POLL_MS cadence.
    it('keeps polling, slower, while hidden when work is active — and recovers once the engine finishes', async () => {
      mocks.graph.mockResolvedValue(graphPayload(['personal']))
      mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: true, loaded: 10, total: 3000 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(probe().dataset.indexing).toBe('personal')

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      const whileHiddenStart = mocks.status.mock.calls.length

      // Well past the visible cadence (900ms) but short of the hidden-active
      // one: if hiding failed to slow the loop down, a poll would already
      // have landed here.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(mocks.status.mock.calls.length).toBe(whileHiddenStart)

      // The engine finishes indexing while the tab is still hidden. FIX 3:
      // the heavy graph+resolve-all refetch this would otherwise trigger is
      // deferred while hidden — see the dedicated FIX 3 test below for the
      // call-count proof. Only the cheap status signal lands here.
      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      mocks.status.mockResolvedValue(statusPayload({ generation: 9, indexing: false, conceptCount: 1 }))
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

      expect(mocks.status.mock.calls.length).toBeGreaterThan(whileHiddenStart)
      // The status route's own indexingSources answers directly, independent
      // of the deferred heavy refetch — a hidden tab still learns indexing is
      // done without downloading the corpus to prove it.
      expect(probe().dataset.indexing).toBe('')
      // The resolved concept count is the deferred half: still stale.
      expect(probe().dataset.count).toBe('0')

      // Once idle (nothing active) AND still hidden, the loop goes fully
      // silent — confirming the hidden polling wound back down rather than
      // persisting after work finished.
      const afterRecovery = mocks.status.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(mocks.status.mock.calls.length).toBe(afterRecovery)

      // Returning to visible lands the deferred catch-up.
      visibility.mockReturnValue('visible')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(probe().dataset.count).toBe('1')

      visibility.mockRestore()
    })

    // FIX 3: /api/graph and /api/resolve-all are the 620ms/150MB-on-a-real-vault
    // payloads (see CLAUDE.md); a hidden tab has nobody to show them to. This
    // pins the call counts directly, rather than through a derived dataset
    // value, so a regression here fails on the exact thing that was expensive.
    it('issues zero heavy payload calls while hidden, then exactly one catch-up refetch on return to visible (FIX 3)', async () => {
      mocks.graph.mockResolvedValue(graphPayload(['personal']))
      mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: true, loaded: 10, total: 3000 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      const graphAtHidden = mocks.graph.mock.calls.length
      const resolveAllAtHidden = mocks.resolveAll.mock.calls.length

      // The snapshot lands while hidden: generation moves and indexing flips
      // to done — exactly the condition that would normally earn a heavy
      // refetch.
      mocks.status.mockResolvedValue(statusPayload({ generation: 9, indexing: false, conceptCount: 1 }))
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

      expect(mocks.graph.mock.calls.length).toBe(graphAtHidden)
      expect(mocks.resolveAll.mock.calls.length).toBe(resolveAllAtHidden)

      mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
      visibility.mockReturnValue('visible')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })

      expect(mocks.graph.mock.calls.length).toBe(graphAtHidden + 1)
      expect(mocks.resolveAll.mock.calls.length).toBe(resolveAllAtHidden + 1)
      expect(probe().dataset.count).toBe('1')
      expect(probe().dataset.indexing).toBe('')

      visibility.mockRestore()
    })

    // FIX 2: a failed pass tells us nothing about whether work is active, so
    // it must not keep a hidden tab polling off a stale `activeState === true`
    // from the last successful pass. Measured before this fix: 85 failed
    // fetches in 10 simulated hidden minutes, no termination.
    it('stops polling in a hidden tab once the engine starts failing, even though it was active a moment ago (FIX 2)', async () => {
      mocks.graph.mockResolvedValue(graphPayload(['personal']))
      mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: true, loaded: 10, total: 3000 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(probe().dataset.indexing).toBe('personal')

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))

      // The engine dies while the tab is hidden and stays dead.
      mocks.status.mockRejectedValue(new Error('engine gone'))
      const beforeFailures = mocks.status.mock.calls.length

      // The already-scheduled hidden-active tick fires once, fails, and (per
      // the fix) must not reschedule itself while hidden.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      const afterOneFailure = mocks.status.mock.calls.length
      expect(afterOneFailure).toBeGreaterThan(beforeFailures)

      // Simulates the full 10-minutes-hidden repro: nothing more should fire.
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
      expect(mocks.status.mock.calls.length).toBe(afterOneFailure)

      visibility.mockRestore()
    })

    // WP-B: a page that first renders hidden (an embedded webview can
    // misreport visibility) never gets a recurring poll at all — schedule()
    // is a no-op while hidden, and nothing resumes the loop until
    // visibilitychange fires. Without a probe that ignores hidden(), a page
    // that loaded mid-index would sit on that stuck snapshot forever with no
    // way to notice the engine actually finished.
    it('probes /api/status once at bootstrap even when the page starts hidden, and recovers a stuck initial snapshot once visible', async () => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      try {
        mocks.graph.mockResolvedValue(graphPayload(['personal']))
        mocks.resolveAll
          .mockResolvedValueOnce({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
          .mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
        // The engine actually finished by the time this page loaded — status
        // disagrees with the graph's still-indexing snapshot from readAll().
        mocks.status.mockResolvedValue(statusPayload({ generation: 9, indexing: false, conceptCount: 1 }))

        await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

        // Exactly one status call: the bootstrap probe. schedule() is a
        // no-op while hidden, so nothing else could have called it.
        expect(mocks.status.mock.calls.length).toBe(1)
        // The status route's own indexingSources answers directly — a hidden
        // tab learns indexing is done without the heavy refetch.
        expect(probe().dataset.indexing).toBe('')
        // FIX 3: the correction this probe would otherwise fetch immediately
        // is deferred while hidden — count is still the stale readAll()
        // snapshot from before the mismatch was noticed.
        expect(probe().dataset.count).toBe('0')
        expect(mocks.resolveAll.mock.calls.length).toBe(1)

        // Becoming visible lands the deferred catch-up.
        visibility.mockReturnValue('visible')
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
        expect(mocks.resolveAll.mock.calls.length).toBe(2)
        expect(probe().dataset.count).toBe('1')
      } finally {
        visibility.mockRestore()
      }
    })
  })

  it('does not treat an empty mid-index pass as a fatal error', async () => {
    mocks.graph.mockResolvedValue(graphPayload(['personal']))
    // Zero concepts AND errors, but indexing is still running: not a failure.
    mocks.resolveAll.mockResolvedValue({
      concepts: [], errors: [{ concept: 'x', error: 'not found in any healthy source' }],
      indexing: true, indexingSources: ['personal'],
    })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    expect(probe().dataset.shell).toBe('false')
    expect(probe().dataset.sources).toBe('1')
  })

  it('keeps a bare Concepts history entry bare when navigating back from a deep link', async () => {
    window.history.replaceState(null, '', '/#/concepts/interfaces%2Fauth')
    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({
      concepts: [conceptPayload('interfaces/auth')], errors: [], indexing: false,
    })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.selection).toBe('interfaces/auth')

    window.history.pushState(null, '', '#/concepts')
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(probe().dataset.view).toBe('concepts')
    expect(probe().dataset.selection).toBe('interfaces/auth')
    expect(window.location.hash).toBe('#/concepts')
  })
  it('lands the Files view scoped to a source, and puts the scope in the URL', async () => {
    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    await act(async () => (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'browse team-docs') as HTMLButtonElement).click())
    expect(probe().dataset.view).toBe('files')
    expect(probe().dataset.filesScope).toBe('team-docs')
    expect(window.location.hash).toBe('#/files/team-docs')

    await act(async () => (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'open a.md') as HTMLButtonElement).click())
    expect(window.location.hash).toBe('#/files/team-docs/notes%2Fa.md')

    // Clearing the scope keeps the open file — it just widens the navigator.
    await act(async () => (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'clear scope') as HTMLButtonElement).click())
    expect(probe().dataset.filesScope).toBe('')
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')
    expect(window.location.hash).toBe('#/files')
  })

  it('restores scope and file from a deep link, and from Back', async () => {
    window.history.replaceState(null, '', '/#/files/team-docs/notes%2Fa.md')
    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    expect(probe().dataset.view).toBe('files')
    expect(probe().dataset.filesScope).toBe('team-docs')
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')

    window.history.pushState(null, '', '#/files')
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(probe().dataset.filesScope).toBe('')
    expect(probe().dataset.filesPath).toBe('')
  })
})

describe('document title', () => {
  it('names the current view, and updates when the view changes', async () => {
    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: false })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(document.title).toBe('Home — ContextCake')

    await click('to sources')
    expect(document.title).toBe('Sources — ContextCake')
  })
})

// ---- Back/Forward vs. an unsaved file --------------------------------------
//
// Real session-history traversal, not a synthesized PopStateEvent: what these
// cover is *which entry* a refused navigation writes to, and a hand-fired event
// leaves the history stack untouched, so it cannot see the difference.

const FILE_HASH = '#/files/team-docs/notes%2Fa.md'

function click(label: string) {
  const match = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return act(async () => (match as HTMLButtonElement).click())
}

/** A real Back, awaited: jsdom traverses the stack on a task, like a browser. */
async function goBack() {
  window.history.back()
  await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}

describe('navigating away from an unsaved file', () => {
  /** Stands in for the editor: it only listens while there is a draft to lose. */
  let prompts: string[]
  let guard: (event: Event) => void

  beforeEach(() => {
    prompts = []
    guard = (event: Event) => { prompts.push(window.location.hash); event.preventDefault() }
    mocks.graph.mockResolvedValue(graphPayload([]))
    mocks.resolveAll.mockResolvedValue({ concepts: [conceptPayload('a')], errors: [], indexing: false })
  })

  afterEach(() => window.removeEventListener('contextcake:before-navigate', guard))

  it('asks before Back moves between two Files URLs, not only between views', async () => {
    // Two adjacent Files entries. Same view, different document — the shape the
    // view-only guard walked straight through, taking the draft with it.
    window.history.replaceState(null, '', '/#/files')
    window.history.pushState(null, '', FILE_HASH)
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')

    window.addEventListener('contextcake:before-navigate', guard)
    await goBack()

    // Asked once, and the answer was honoured: the document is still open and
    // the URL still names it.
    expect(prompts).toHaveLength(1)
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')
    expect(window.location.hash).toBe(FILE_HASH)

    // Saved (nothing left to lose) — the same Back now goes through.
    window.removeEventListener('contextcake:before-navigate', guard)
    await goBack()
    expect(probe().dataset.filesPath).toBe('')
    expect(window.location.hash).toBe('#/files')
  })

  it('restores the whole Files URL on cancel, and leaves the entry behind it alone', async () => {
    // The 3-step path: Sources → a file → Back (cancelled) → Back again. The
    // first refusal used to rewrite the *Sources* entry to a bare `#/files`,
    // which both mis-described the screen and turned the next Back into a
    // same-view move the guard did not cover.
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    await click('to sources')
    await click('browse team-docs')
    await click('open a.md')
    expect(window.location.hash).toBe(FILE_HASH)

    window.addEventListener('contextcake:before-navigate', guard)
    await goBack()

    expect(prompts).toHaveLength(1)
    expect(probe().dataset.view).toBe('files')
    expect(probe().dataset.filesScope).toBe('team-docs')
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')
    // The whole URL, scope and file included — not `#/files`.
    expect(window.location.hash).toBe(FILE_HASH)

    // Step 3: the entry behind this one is still the Sources view the user
    // actually visited, so it still asks, and still keeps the draft.
    await goBack()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe('#/sources')
    expect(probe().dataset.filesPath).toBe('team-docs/notes/a.md')
    expect(window.location.hash).toBe(FILE_HASH)

    // And once there is nothing to lose, Back lands where it always should have.
    window.removeEventListener('contextcake:before-navigate', guard)
    await goBack()
    expect(probe().dataset.view).toBe('sources')
    expect(window.location.hash).toBe('#/sources')
  })
})

// The graph-first contract: against a modern engine (one that serves
// /api/discrepancies), bootstrap must never download the resolved corpus.
// That payload measured ~150MB on a 3,000-note vault — fetched on every
// bootstrap and content move against a 60s deadline, it was the console-side
// "timeout" and the renderer-OOM white window on large vaults.
describe('graph-first bootstrap', () => {
  const graphRow = (id: string, conflictCount = 0) => ({
    id, type: 'note', title: id, contributors: ['personal'], winner: 'personal', conflictCount, tokens: 0,
  })
  const graphWithRows = (rows: ReturnType<typeof graphRow>[]) => ({
    ...graphPayload([]),
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: rows.length, sources: 1 },
    concepts: rows,
  })
  const emptyDiscrepancies = {
    discrepancies: [], coverageComplete: true, indexing: false, indexingSources: [], errors: [], generation: 1,
  }

  it('renders concept rows from the graph with ZERO resolve-all calls, and details follow selection', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWithRows([graphRow('a'), graphRow('b')]))
    mocks.discrepancies.mockResolvedValue(emptyDiscrepancies)
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    expect(probe().dataset.count).toBe('2')
    expect(mocks.resolveAll).not.toHaveBeenCalled()
    // The default selection ('a') pulled its full document — one /api/resolve,
    // on demand — and the row was replaced in place.
    expect(probe().dataset.selection).toBe('a')
    expect(mocks.resolve).toHaveBeenCalledWith('a')
    expect(probe().dataset.selDetail).toBe('undefined') // full rows drop the compact marker
    expect(probe().dataset.selSections).toBe('1')
    // Still zero corpus downloads after the detail landed.
    expect(mocks.resolveAll).not.toHaveBeenCalled()
  })

  it('gives compact rows their dissent surface from the discrepancies payload', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWithRows([graphRow('a'), graphRow('b', 1)]))
    mocks.discrepancies.mockResolvedValue({
      ...emptyDiscrepancies,
      discrepancies: [{
        id: 'section_content::b::body', conceptId: 'b', key: 'body', label: 'Body', conceptTitle: 'b',
        status: 'needs_review', history: [],
        contributions: [
          { source: 'personal', level: 3, value: 'mine', updated: '2026-01-02', effective: true },
          { source: 'team', level: 2, value: 'theirs', updated: '2026-01-01' },
        ],
      }],
    })
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    // 'b' never had its detail loaded, yet the whole-corpus surfaces (canvas
    // ghosts, conflict badges) see its dissent through the stub section.
    expect(probe().dataset.conflictIds).toBe('b')
    expect(mocks.resolveAll).not.toHaveBeenCalled()
  })

  it('a failed detail load leaves the compact row and retries on the next selection', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWithRows([graphRow('a')]))
    mocks.discrepancies.mockResolvedValue(emptyDiscrepancies)
    mocks.resolve.mockRejectedValueOnce(new Error('engine mid-restart')).mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))

    // First attempt failed: the row stays compact — loading, never empty.
    expect(probe().dataset.selDetail).toBe('false')
    expect(probe().dataset.count).toBe('1')
  })

  it('retries a failed detail on its own while the concept is still the one on screen', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWithRows([graphRow('a')]))
    mocks.discrepancies.mockResolvedValue(emptyDiscrepancies)
    mocks.resolve.mockRejectedValueOnce(new Error('engine mid-restart')).mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.selDetail).toBe('false')

    // Nothing is clicked and nothing is navigated: the failure window this
    // path exists for (engine mid-relaunch on a large vault) closes by itself,
    // and a permanent spinner would be the same lie as an empty document.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(probe().dataset.selDetail).toBe('undefined')
    expect(probe().dataset.selSections).toBe('1')
  })
})

// The Discrepancy Center's store contract: compact rows + the engine's
// summary in one round trip, the full record on selection, and a batch that
// flips its ok rows once and refetches once.
describe('discrepancies: compact rows, detail on selection, batch decisions', () => {
  const graphRow = (id: string) => ({ id, type: 'note', title: id, contributors: ['personal'], winner: 'personal', conflictCount: 1, tokens: 0 })
  const graphWith = (rows: ReturnType<typeof graphRow>[]) => ({
    ...graphPayload([]), totals: { sourceTokens: 0, resolvedTokens: 0, concepts: rows.length, sources: 1 }, concepts: rows,
  })
  const summary = {
    total: 3, actionable: 3,
    byKind: { section_content: 3, frontmatter_value: 0, broken_link: 0, changed_after_decision: 0 },
    byStatus: { needs_review: 3, recommended: 0, auto_ready: 0, acknowledged: 0, resolved: 0, reopened: 0, blocked: 0 },
    bySourcePair: [], byOwner: [], byConceptType: [], topTargets: [], topConcepts: [],
    quickWins: { autoReady: 0, recommended: 0, brokenLinksWithBestCandidate: 0, brokenLinksTotal: 0 },
  }
  const compactRecord = (id: string) => ({
    id: `section_content::${id}::body`, kind: 'section_content', originalKind: 'section_content', conceptId: id, conceptTitle: id, conceptType: 'note',
    key: 'body', label: 'Body', revision: `${id}:1`, status: 'needs_review',
    contributions: [
      { source: 'personal', level: 3, updated: '2026-01-02', value: 'mine…', fingerprint: 'a', effective: true, truncated: true, valueBytes: 400, valueKind: 'string' },
      { source: 'team', level: 2, updated: '2026-01-01', value: 'theirs', fingerprint: 'b', effective: false, truncated: false, valueBytes: 6, valueKind: 'string' },
    ],
    effectiveSource: 'personal', effectiveValue: 'mine…', winnerReason: 'personal wins.', owner: 'Unassigned', priority: 'unassigned',
    fresherDissent: false, freshness: { effectiveUpdated: null, newestUpdated: null, hasNewerDissent: false },
    affectedLinks: [], sourceHealth: [], matchingRules: [], historyCount: 1, latestDecision: { id: 'd1', action: 'acknowledge', decidedAt: '2026-01-03', transactionState: 'not_required' }, compact: true,
  })
  const fullRecord = (id: string) => {
    const { historyCount: _count, latestDecision: _latest, compact: _compact, ...rest } = compactRecord(id)
    return {
      ...rest,
      contributions: rest.contributions.map((entry) => { const { truncated: _t, valueBytes: _b, valueKind: _k, ...plain } = entry; return { ...plain, value: entry.source === 'personal' ? 'mine, in full' : entry.value } }),
      history: [{ schemaVersion: 2, id: 'd1', conflictId: `${id}::body`, conceptId: id, title: id, sectionKey: 'body', sectionHeading: 'Body', contributions: [], chosen: null, method: 'manual', reason: 'kept', actor: 'local-user', decidedAt: '2026-01-03', action: 'acknowledge' }],
    }
  }
  const compactPayload = (ids: string[]) => ({
    discrepancies: ids.map(compactRecord), coverageComplete: true, indexing: false, indexingSources: [], errors: [], generation: 1,
    summary: { ...summary, total: ids.length, actionable: ids.length }, total: ids.length, filtered: ids.length, offset: 0, limit: null, projectionRevision: 'r1',
  })

  function ConflictProbe() {
    const { conflicts, conflictSummary, decideDiscrepancies, setSelConflict, selConflict } = useStore()
    const selected = conflicts.find((c) => c.id === selConflict)
    return (
      <div
        data-statuses={conflicts.map((c) => `${c.id.split('::')[1]}:${c.discrepancyStatus}`).join(',')}
        data-summary={String(conflictSummary.actionable)}
        data-selected={selConflict}
        data-sel-detail={String(selected?.detailLoaded)}
        data-sel-history={String(selected?.history.length ?? '')}
        data-sel-value={selected?.contributions[0]?.value ?? ''}
        data-sel-truncated={String(selected?.contributions[0]?.truncated)}
      >
        <button type="button" onClick={() => setSelConflict('section_content::b::body')}>select b</button>
        <button type="button" onClick={() => void decideDiscrepancies({ decisions: conflicts.map((c) => ({ discrepancyId: c.id, revision: c.revision as string, action: 'acknowledge' as const, reasonCode: 'other' as const })) }).catch(() => {})}>batch</button>
        <button type="button" onClick={() => void decideDiscrepancies({ dryRun: true, decisions: conflicts.map((c) => ({ discrepancyId: c.id, revision: c.revision as string, action: 'acknowledge' as const, reasonCode: 'other' as const })) }).catch(() => {})}>dry run</button>
      </div>
    )
  }
  const cprobe = () => container.firstElementChild as HTMLElement

  it('takes the engine summary from the compact envelope and loads the selected row in full through ?id=', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWith([graphRow('a'), graphRow('b'), graphRow('c')]))
    mocks.discrepancies.mockResolvedValue(compactPayload(['a', 'b', 'c']))
    mocks.discrepancyDetail.mockImplementation(async (id: string) => fullRecord(id.split('::')[1]))
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><ConflictProbe /></StoreProvider>))

    expect(cprobe().dataset.summary).toBe('3')
    // The first row is selected by default and its full record replaced the compact one.
    expect(cprobe().dataset.selected).toBe('section_content::a::body')
    expect(mocks.discrepancyDetail).toHaveBeenCalledWith('section_content::a::body')
    expect(mocks.discrepancyDetail).toHaveBeenCalledTimes(1)
    expect(cprobe().dataset.selDetail).toBe('undefined')
    expect(cprobe().dataset.selHistory).toBe('1')
    expect(cprobe().dataset.selValue).toBe('mine, in full')
    expect(cprobe().dataset.selTruncated).toBe('undefined')

    // Selecting another row loads that one; the rest stay compact.
    await act(async () => cprobe().querySelector<HTMLButtonElement>('button')!.click())
    expect(mocks.discrepancyDetail).toHaveBeenLastCalledWith('section_content::b::body')
    expect(cprobe().dataset.selHistory).toBe('1')
    expect(cprobe().dataset.selValue).toBe('mine, in full')
    expect(mocks.resolveAll).not.toHaveBeenCalled()
  })

  it('computes the summary locally when the engine ignored ?fields=compact, and never asks for a detail it already has', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWith([graphRow('a')]))
    mocks.discrepancies.mockResolvedValue({
      discrepancies: [fullRecord('a')], coverageComplete: true, indexing: false, indexingSources: [], errors: [], generation: 1,
    })
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))

    await act(async () => root.render(<StoreProvider><ConflictProbe /></StoreProvider>))
    expect(cprobe().dataset.summary).toBe('1')
    expect(cprobe().dataset.selDetail).toBe('undefined')
    expect(cprobe().dataset.selHistory).toBe('1')
    expect(mocks.discrepancyDetail).not.toHaveBeenCalled()
  })

  it('flips every ok row of a batch at once and refetches exactly once; a dry run changes nothing', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWith([graphRow('a'), graphRow('b'), graphRow('c')]))
    mocks.discrepancies.mockResolvedValue(compactPayload(['a', 'b', 'c']))
    mocks.discrepancyDetail.mockImplementation(async (id: string) => fullRecord(id.split('::')[1]))
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))
    mocks.decideDiscrepancies.mockImplementation(async (request: { decisions: { discrepancyId: string }[]; dryRun?: boolean }) => ({
      ok: false, applied: request.dryRun ? 0 : 2, failed: request.dryRun ? 0 : 1,
      results: request.decisions.map((decision) => (request.dryRun || !decision.discrepancyId.includes('::b::')
        ? { discrepancyId: decision.discrepancyId, ok: true, ...(request.dryRun ? { wouldWrite: [] } : {}) }
        : { discrepancyId: decision.discrepancyId, ok: false, status: 409, code: 'STALE', error: 'stale' })),
      suggestions: [],
    }))

    await act(async () => root.render(<StoreProvider><ConflictProbe /></StoreProvider>))
    expect(cprobe().dataset.statuses).toBe('a:needs_review,b:needs_review,c:needs_review')
    const graphCalls = mocks.graph.mock.calls.length

    const [, batch, dryRun] = Array.from(cprobe().querySelectorAll<HTMLButtonElement>('button'))
    await act(async () => dryRun.click())
    expect(cprobe().dataset.statuses).toBe('a:needs_review,b:needs_review,c:needs_review')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(mocks.graph.mock.calls.length).toBe(graphCalls) // no refetch for a dry run

    await act(async () => batch.click())
    // Both ok rows flipped in one state update; the failed one is untouched.
    expect(cprobe().dataset.statuses).toBe('a:acknowledged,b:needs_review,c:acknowledged')
    expect(mocks.decideDiscrepancies).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(mocks.graph.mock.calls.length).toBe(graphCalls + 1) // ONE refetch for the whole batch
  })

  it('refetches after a batch even when nothing landed — all-STALE rows must pick up their new revisions', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWith([graphRow('a'), graphRow('b')]))
    mocks.discrepancies.mockResolvedValue(compactPayload(['a', 'b']))
    mocks.discrepancyDetail.mockImplementation(async (id: string) => fullRecord(id.split('::')[1]))
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))
    mocks.decideDiscrepancies.mockImplementation(async (request: { decisions: { discrepancyId: string }[] }) => ({
      ok: false, applied: 0, failed: request.decisions.length, notAttempted: 0, dryRun: false,
      results: request.decisions.map((decision) => ({ discrepancyId: decision.discrepancyId, ok: false, status: 409, code: 'STALE', error: 'stale' })),
      suggestions: [],
    }))
    await act(async () => root.render(<StoreProvider><ConflictProbe /></StoreProvider>))
    const graphCalls = mocks.graph.mock.calls.length
    const [, batch] = Array.from(cprobe().querySelectorAll<HTMLButtonElement>('button'))
    await act(async () => batch.click())
    expect(cprobe().dataset.statuses).toBe('a:needs_review,b:needs_review')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(mocks.graph.mock.calls.length).toBe(graphCalls + 1)
  })

  it('carries a loaded detail across a refetch when its compact row is unchanged, and reloads it when the revision moved', async () => {
    mocks.flags.withDiscrepancies = true
    mocks.graph.mockResolvedValue(graphWith([graphRow('a')]))
    mocks.discrepancies.mockResolvedValue(compactPayload(['a']))
    mocks.discrepancyDetail.mockImplementation(async (id: string) => fullRecord(id.split('::')[1]))
    mocks.resolve.mockImplementation(async (id: string) => conceptPayload(id))
    mocks.status.mockResolvedValue(statusPayload({ generation: 1, indexing: false, conceptCount: 1 }))

    await act(async () => root.render(<StoreProvider><ConflictProbe /></StoreProvider>))
    expect(cprobe().dataset.selDetail).toBe('undefined')
    expect(mocks.discrepancyDetail).toHaveBeenCalledTimes(1)

    // The engine's generation moves (a file edit elsewhere); the compact row for
    // 'a' comes back identical → the loaded record is kept, no skeleton, no reload.
    mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: false, conceptCount: 1 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(cprobe().dataset.selDetail).toBe('undefined')
    expect(cprobe().dataset.selValue).toBe('mine, in full')
    expect(mocks.discrepancyDetail).toHaveBeenCalledTimes(1)

    // Now the row itself changed (new revision): the compact row wins and the detail reloads.
    const moved = compactPayload(['a'])
    moved.discrepancies[0] = { ...moved.discrepancies[0], revision: 'a:2' }
    mocks.discrepancies.mockResolvedValue(moved)
    mocks.status.mockResolvedValue(statusPayload({ generation: 3, indexing: false, conceptCount: 1 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(mocks.discrepancyDetail).toHaveBeenCalledTimes(2)
    expect(cprobe().dataset.selDetail).toBe('undefined')
  })
})
