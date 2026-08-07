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
})
