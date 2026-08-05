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

const mocks = vi.hoisted(() => ({ graph: vi.fn(), resolveAll: vi.fn(), conflictResolutions: vi.fn() }))

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
      conflictResolutions: mocks.conflictResolutions,
      resolveConflict: vi.fn(),
    }),
  }
})

let container: HTMLDivElement
let root: Root

/** Renders the store's load state so assertions read it from the DOM. */
function Probe() {
  const { load, concepts, sources, reload } = useStore()
  return (
    <div
      data-shell={String(load.shell)}
      data-concepts={String(load.concepts)}
      data-indexing={load.indexingSources.join(',')}
      data-count={String(concepts.length)}
      data-sources={String(sources.length)}
    ><button type="button" onClick={reload}>reload</button></div>
  )
}

const probe = () => container.firstElementChild as HTMLElement

function graphPayload(indexingSources: string[]) {
  return {
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
    indexing: indexingSources.length > 0,
    indexingSources,
    sources: [{
      name: 'personal', level: 3, kind: 'files', conceptCount: 0, tokens: 0,
      latestUpdated: null, status: indexingSources.length ? 'indexing' : 'ok', error: null,
    }],
    concepts: [],
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
  mocks.conflictResolutions.mockResolvedValue([])
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

  it('stops claiming to index after repeated failures rather than spinning', async () => {
    mocks.graph
      .mockResolvedValueOnce(graphPayload(['personal']))
      .mockRejectedValue(new Error('server went away'))
    mocks.resolveAll.mockResolvedValueOnce({
      concepts: [], errors: [], indexing: true, indexingSources: ['personal'],
    })

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>))
    expect(probe().dataset.indexing).toBe('personal')

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    // The banner must not outlive the polling that would clear it.
    expect(probe().dataset.indexing).toBe('')
    expect(probe().dataset.concepts).toBe('false')
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
})
