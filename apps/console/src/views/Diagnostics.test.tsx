// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Diagnostics, grafanaUrl, retrievalSummary } from './Diagnostics'
import { DiagnosticActivity } from './DiagnosticActivity'

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

it('distinguishes unavailable activity and makes interval counts accessible', async () => {
  const container = document.createElement('div'),
    root = createRoot(container)
  await act(async () =>
    root.render(<DiagnosticActivity rows={[]} from={0} to={0} />),
  )
  expect(container.textContent).toContain('Waiting for the engine')
  expect(container.textContent).not.toContain('0 observed')
  await act(async () =>
    root.render(<DiagnosticActivity rows={[]} from={100} to={200} />),
  )
  expect(container.textContent).toContain('No retrieval activity yet')
  await act(async () =>
    root.render(
      <DiagnosticActivity
        rows={[
          { at: 100, operation: 'search', outcome: 'error', durationMs: 1 },
        ]}
        from={100}
        to={100}
      />,
    ),
  )
  expect(container.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('details summary')?.textContent).toBe(
    'View interval counts',
  )
  expect(container.querySelectorAll('tbody tr')).toHaveLength(12)
  expect(
    [...container.querySelectorAll('tbody tr:first-child td')].map(
      (cell) => cell.textContent,
    ),
  ).toEqual(['1', '0', '1'])
  await act(async () => root.unmount())
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
  expect(container.textContent).toContain('Sample data')
  expect(container.textContent).toContain('Sample desktop engine')
  expect(container.textContent).toContain('1 source needs attention')
  expect(container.textContent).toContain('never connects to your computer')
  expect(container.textContent).not.toContain('Pause updates')
  const grafana = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Grafana',
  )!
  await act(async () => grafana.click())
  expect(container.textContent).toContain('Sample dashboard summary')
  expect(container.textContent).toContain('Retrieval duration p95')
  expect(container.textContent).toContain('Failures per second')
  expect(container.textContent).toContain('Latest index duration')
  expect(container.textContent).toContain('Latest index queue wait')
  expect(container.textContent).toContain('Documents read and reused · process totals')
  expect(container.textContent).toContain('coverage')
  expect(container.querySelector('iframe')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})

it('refuses non-local frame origins and encodes trace navigation', () => {
  expect(
    grafanaUrl('http://127.0.0.1:3000', 'light', 'now-1h&theme=dark'),
  ).toBeNull()
  expect(grafanaUrl('http://127.0.0.1:3000', 'system', 'now-1h')).toBeNull()
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

it('activity counts only observed retrievals and preserves failures at window boundaries', async () => {
  const { activityBuckets } = await import('./DiagnosticActivity')
  const bins = activityBuckets(
    [
      { at: 100, operation: 'search', outcome: 'ok', durationMs: 1 },
      { at: 1200, operation: 'read', outcome: 'error', durationMs: 2 },
      { at: 50, operation: 'search', outcome: 'ok', durationMs: 1 },
      { at: 500, operation: 'index', outcome: 'error', durationMs: 2 },
    ],
    100,
    1200,
  )
  expect(bins[0].search).toBe(1)
  expect(bins[bins.length - 1]).toEqual({ search: 0, read: 1, errors: 1 })
  expect(bins.reduce((sum, b) => sum + b.search + b.read, 0)).toBe(2)
})

it('withholds stale trace links until exporter evidence matches the cleared history', async () => {
  vi.useFakeTimers()
  state.mode = 'live'
  const traceId = 'a'.repeat(32)
  let generation = 0
  const report = {
    observedFrom: 100,
    observedTo: 200,
    sampleCount: 1,
    operations: [
      { at: 150, operation: 'search', outcome: 'ok', durationMs: 2, traceId },
    ],
    telemetry: {
      state: 'ready',
      sent: 1,
      queued: 0,
      dropped: 0,
      historyGeneration: 0,
      exportedTraceIds: [traceId],
    },
    health: { memory: 'normal', sources: [] },
    indexing: { events: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => report })),
  )
  vi.stubGlobal('__CC_DESKTOP', {
    observability: {
      status: async () => ({
        state: 'ready',
        enabled: true,
        origin: 'http://127.0.0.1:1234',
        historyGeneration: generation,
      }),
    },
  })
  const container = document.createElement('div'),
    root = createRoot(container)
  await act(async () => root.render(<Diagnostics />))
  const trace = () =>
    container.querySelector('button[aria-label^="View search trace"]')
  expect(trace()).not.toBeNull()
  generation = 1
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(trace()).toBeNull()
  report.telemetry.historyGeneration = 1
  report.telemetry.exportedTraceIds = []
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(trace()).toBeNull()
  await act(async () => root.unmount())
})
