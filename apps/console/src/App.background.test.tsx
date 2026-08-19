// @vitest-environment jsdom
// Shell-level background-work behaviour, against a live-shaped data source.
//
// These are the two regressions from the 0.5.0 field report, expressed as
// assertions on what is actually on screen: a vault mid-index must never be
// described as finished, and a refresh that has started failing must say so
// rather than leaving a frozen page looking live.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider } from './theme-mode'

const mocks = vi.hoisted(() => ({
  graph: vi.fn(), resolveAll: vi.fn(), status: vi.fn(), conflictResolutions: vi.fn(),
}))

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

function indexingGraph() {
  return {
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
    indexing: true,
    indexingSources: ['field-vault'],
    generation: 2,
    sources: [{
      name: 'field-vault', level: 3, kind: 'files', conceptCount: 0, tokens: 0, latestUpdated: null,
      status: 'indexing', error: null,
      indexing: { status: 'indexing' as const, phase: 'loading', loaded: 1240, total: 3000, elapsedMs: 8200 },
    }],
    concepts: [],
  }
}

const activity = () => container.querySelector<HTMLButtonElement>('.cc-activity')
const bannerText = () => Array.from(container.querySelectorAll('[role="status"]'))
  .map((n) => n.textContent ?? '').join(' | ')

/** The rendered Sources row for a layer, as text — what the user actually reads. */
const sourceRow = (name: string) => Array.from(container.querySelectorAll('button'))
  .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
  .find((t) => t.startsWith(name) && / #\d+( \(tied\))? in cascade/.test(t)) ?? '(no row)'

/**
 * One engine whose state advances, answering every route from it — so no test
 * can pass by mocking /api/status and /api/graph into disagreeing with each
 * other. Progress moves `generation` on every tick, exactly as the real engine
 * does (it counts documents into it), which is what the poll's refetch gate has
 * to survive.
 */
function fakeEngine() {
  const state = { generation: 2, phase: 'scanning', loaded: 0, total: null as number | null, count: 0 }
  const indexing = () => state.phase !== 'ready'
  return {
    advance(next: Partial<typeof state>) { Object.assign(state, next); state.generation += 1 },
    status: () => ({
      generation: state.generation,
      indexing: indexing(),
      indexingSources: indexing() ? ['field-vault'] : [],
      sources: [{
        name: 'field-vault', level: 3, kind: 'files',
        status: indexing() ? 'indexing' : 'ok', phase: state.phase,
        loaded: state.loaded, total: state.total, conceptCount: state.count,
        refreshing: false, error: null,
      }],
    }),
    graph: () => ({
      totals: { sourceTokens: 0, resolvedTokens: 0, concepts: state.count, sources: 1 },
      indexing: indexing(),
      indexingSources: indexing() ? ['field-vault'] : [],
      generation: state.generation,
      sources: [{
        name: 'field-vault', level: 3, kind: 'files', conceptCount: state.count, tokens: 0,
        latestUpdated: null, status: indexing() ? 'indexing' : 'ok', error: null,
        ...(indexing()
          ? { indexing: { status: 'indexing' as const, phase: state.phase, loaded: state.loaded, total: state.total, elapsedMs: 100 } }
          : {}),
      }],
      concepts: [],
    }),
    resolveAll: () => ({
      concepts: state.count > 0
        ? [{
            id: 'note',
            contributors: [{ layer: 'field-vault', level: 3, updated: '2026-01-01' }],
            frontmatter: { title: 'note', type: 'note' },
            sections: [{ key: 'body', heading: '## Body {#body}', content: 'x', sourceLayer: 'field-vault', sourceUpdated: '2026-01-01' }],
          }]
        : [],
      errors: [],
      indexing: indexing(),
      indexingSources: indexing() ? ['field-vault'] : [],
    }),
  }
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '/#/sources')
  window.localStorage.clear()
  delete window.__CC_DESKTOP
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.conflictResolutions.mockResolvedValue([])
  mocks.status.mockResolvedValue(null)
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('background work in the shell', () => {
  it('never describes a still-indexing source as synced, anywhere on screen', async () => {
    mocks.graph.mockResolvedValue(indexingGraph())
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['field-vault'] })

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    const text = container.textContent ?? ''
    expect(text).toContain('indexing')
    expect(text).not.toContain('synced')
    // The exact lie from the field report, in both of its halves.
    expect(text).not.toContain('0 concepts')
    expect(text).toContain('1,240 / 3,000')
    expect(activity()?.textContent).toContain('Indexing · 41%')
  })

  it('surfaces a failing refresh and keeps the indexing state it already knew', async () => {
    mocks.graph
      .mockResolvedValueOnce(indexingGraph())
      .mockRejectedValue(new Error('socket hang up'))
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['field-vault'] })

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    // Five-plus consecutive failures: the old code had gone silent by now.
    expect(mocks.graph.mock.calls.length).toBeGreaterThan(5)
    expect(bannerText()).toContain('Live refresh failing — retrying')
    expect(bannerText()).toContain('socket hang up')
    expect(activity()?.dataset.tone).toBe('attention')
    // And it has not quietly retracted what it was saying about the vault.
    expect(container.textContent).toContain('field-vault')
    expect(container.textContent).toContain('indexing')
  })

  // The 0.5.0 field report, in full: the row and the toolbar must walk the
  // whole transition on their own. Reaching `ready` is the half that broke —
  // the page sat on the phase the source started in until a manual reload,
  // which is the same class of lie as "synced · 0 concepts".
  it('walks a source from scanning to ready without a reload', async () => {
    const engine = fakeEngine()
    mocks.graph.mockImplementation(async () => engine.graph())
    mocks.status.mockImplementation(async () => engine.status())
    mocks.resolveAll.mockImplementation(async () => engine.resolveAll())

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(sourceRow('field-vault')).toContain('Scanning')
    expect(activity()).not.toBeNull()

    // Reading, with a denominator: progress must reach the row, not just the toolbar.
    engine.advance({ phase: 'loading', loaded: 250, total: 3000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(sourceRow('field-vault')).toContain('250 / 3,000')

    engine.advance({ phase: 'loading', loaded: 1_500, total: 3000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(sourceRow('field-vault')).toContain('1,500 / 3,000')

    // Progress alone must not have pulled the heavy payload back — that is the
    // cheap-poll bargain, and settling has to work without breaking it.
    expect(mocks.resolveAll.mock.calls.length).toBe(1)

    // Done. The row settles and the toolbar indicator goes away, unaided.
    engine.advance({ phase: 'ready', loaded: 3000, total: 3000, count: 3000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    // The snapshot landed, so the concepts behind it were fetched exactly once
    // more. Without this the row could settle off /api/status while the rest of
    // the app still held the empty mid-index cascade.
    expect(mocks.resolveAll.mock.calls.length).toBe(2)
    expect(sourceRow('field-vault')).toContain('3000 concepts')
    expect(sourceRow('field-vault')).not.toContain('Scanning')
    expect(sourceRow('field-vault')).not.toContain('/ 3,000')
    expect(container.textContent).not.toContain('indexing')
    expect(activity()).toBeNull()
  })

  // The other half of that transition, for a keyboard. The indicator leaving
  // the toolbar used to take focus with it: the button unmounted in the same
  // commit as the render that dropped it, focus fell to <body>, and the user
  // was silently returned to the top of the document mid-task.
  it('hands focus to the toolbar rather than dropping it when the indicator retires', async () => {
    const engine = fakeEngine()
    mocks.graph.mockImplementation(async () => engine.graph())
    mocks.status.mockImplementation(async () => engine.status())
    mocks.resolveAll.mockImplementation(async () => engine.resolveAll())

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    const control = activity()!
    await act(async () => control.focus())
    expect(document.activeElement).toBe(control)

    engine.advance({ phase: 'ready', loaded: 3000, total: 3000, count: 3000 })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(activity()).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(container.contains(document.activeElement)).toBe(true)
  })

  it('lets the banner be dismissed without silencing the next distinct failure', async () => {
    mocks.graph
      .mockResolvedValueOnce(indexingGraph())
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValue(new Error('connection refused'))
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['field-vault'] })

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(bannerText()).toContain('socket hang up')

    const dismiss = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Dismiss the live refresh warning')!
    await act(async () => dismiss.click())
    expect(bannerText()).not.toContain('socket hang up')

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(bannerText()).toContain('connection refused')
  })

  // Dismissal is per message, and a recovery ends it. Keeping it meant one
  // click muted that wording for the whole session, so an outage that came
  // back later — same socket, same message — was never reported again.
  it('re-surfaces the same failure when it returns after a recovery', async () => {
    mocks.graph
      .mockResolvedValueOnce(indexingGraph())
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(indexingGraph())
      .mockRejectedValue(new Error('socket hang up'))
    mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: true, indexingSources: ['field-vault'] })

    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(bannerText()).toContain('socket hang up')

    const dismiss = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Dismiss the live refresh warning')!
    await act(async () => dismiss.click())
    expect(bannerText()).not.toContain('socket hang up')

    // The refresh recovers — nothing to say — and then fails the same way again.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(bannerText()).not.toContain('socket hang up')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(bannerText()).toContain('socket hang up')
  })
})
