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

const mocks = vi.hoisted(() => ({ graph: vi.fn(), resolveAll: vi.fn(), conflictResolutions: vi.fn(), status: vi.fn() }))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    createDataSource: () => ({
      mode: 'live' as const,
      graph: mocks.graph,
      resolveAll: mocks.resolveAll,
      resolve: vi.fn(),
      listConcepts: vi.fn(),
      status: mocks.status,
      conflictResolutions: mocks.conflictResolutions,
      resolveConflict: vi.fn(),
    }),
  }
})

let container: HTMLDivElement
let root: Root

/** Renders the store's load state so assertions read it from the DOM. */
function Probe() {
  const { load, concepts, sources, reload, retryNow, view, selConcept, filesScope, filesPath, openFilesScope, setFilesScope, setFilesPath } = useStore()
  return (
    <div
      data-shell={String(load.shell)}
      data-concepts={String(load.concepts)}
      data-indexing={load.indexingSources.join(',')}
      data-count={String(concepts.length)}
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

    it('stops polling while the window is hidden and resumes when it comes back', async () => {
      mocks.graph.mockResolvedValue(graphPayload(['personal']))
      mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['personal'] })
      mocks.status.mockResolvedValue(statusPayload({ generation: 2, indexing: true, loaded: 10, total: 3000 }))

      await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      const whileVisible = mocks.status.mock.calls.length
      expect(whileVisible).toBeGreaterThan(0)

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(mocks.status.mock.calls.length).toBe(whileVisible)

      visibility.mockReturnValue('visible')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(mocks.status.mock.calls.length).toBeGreaterThan(whileVisible)
      visibility.mockRestore()
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
