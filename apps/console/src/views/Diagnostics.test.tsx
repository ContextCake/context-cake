// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Diagnostics, grafanaUrl, retrievalSummary } from './Diagnostics'

const state = vi.hoisted(() => ({ mode: 'demo' }))
vi.mock('../store', () => ({ useStoreData: () => state }))
vi.mock('../api', () => ({
  apiFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}))
vi.mock('../theme-mode', () => ({
  useThemeMode: () => ({
    mode: 'dark',
    density: 'comfortable',
    setDensity: vi.fn(),
  }),
}))
afterEach(() => {
  state.mode = 'demo'
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('never contacts localhost or instantiates a frame in the public demo', async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'),
    root = createRoot(container)
  await act(async () => root.render(<Diagnostics />))
  expect(fetch).not.toHaveBeenCalled()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.textContent).toContain('never connects to your computer')
  await act(async () => root.unmount())
})

it('refuses non-local frame origins and encodes trace navigation', () => {
  for (const origin of [
    'https://grafana.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000@evil.test',
    'http://127.0.0.1:3000/path',
  ])
    expect(grafanaUrl(origin, 'light', 'now-15m')).toBeNull()
  const url = new URL(
    grafanaUrl('http://127.0.0.1:3000', 'dark', 'now-1h', 'a'.repeat(32))!,
  )
  expect(url.pathname).toBe('/d/contextcake-trace/trace')
  expect(url.searchParams.get('theme')).toBe('dark')
  expect(url.searchParams.get('var-traceId')).toBe('a'.repeat(32))
})

it('keeps insufficient samples unknown and separates search from read', () => {
  expect(retrievalSummary([], 'search')).toEqual({
    samples: 0,
    errors: 0,
    median: null,
    p95: null,
  })
  const rows = Array.from({ length: 20 }, (_, i) => ({
    at: i,
    operation: 'search',
    outcome: i === 19 ? 'error' : 'ok',
    durationMs: i + 1,
  }))
  expect(retrievalSummary(rows.slice(0, 19), 'search').p95).toBeNull()
  expect(retrievalSummary(rows, 'search')).toEqual({
    samples: 20,
    errors: 1,
    median: 10.5,
    p95: 19,
  })
  expect(retrievalSummary(rows, 'read').samples).toBe(0)
})

it('renders failed sources with unknown totals and stops polling when paused or unmounted', async () => {
  vi.useFakeTimers()
  state.mode = 'live'
  const report = {
    observedFrom: 100,
    observedTo: 200,
    sampleCount: 0,
    operations: [],
    health: {
      memory: 'normal',
      sources: [
        {
          name: 'Unavailable folder',
          status: 'error',
          phase: 'error',
          loaded: 0,
          total: null,
          warnings: 0,
        },
      ],
    },
    indexing: { events: [] },
  }
  const fetch = vi.fn(async () => ({ ok: true, json: async () => report }))
  vi.stubGlobal('fetch', fetch)
  const container = document.createElement('div'),
    root = createRoot(container)
  await act(async () => root.render(<Diagnostics />))
  expect(container.textContent).toContain('1 needs attention')
  expect(container.textContent).toContain('Unavailable folder')
  expect(container.textContent).toContain('Document total unknown')
  const pause = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Pause updates',
  )!
  await act(async () => pause.click())
  const requests = fetch.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(15000))
  expect(fetch).toHaveBeenCalledTimes(requests)
  expect(container.textContent).toContain('Observation paused')
  await act(async () => root.unmount())
  await act(async () => vi.advanceTimersByTimeAsync(15000))
  expect(fetch).toHaveBeenCalledTimes(requests)
})
