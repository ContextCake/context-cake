// @vitest-environment jsdom
// The shell's honesty contract, at the component level: what the toolbar says
// while the engine is working, and what it says when it has stopped being able
// to ask. Both were previously unrepresentable — a bare "Indexing 2" badge with
// no progress, and, for a failing refresh, nothing at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityDescription, activityLabel, activityName, aggregatePercent, BackgroundActivity, formatElapsed, rateLine } from './BackgroundActivity'
import { LiveDataError } from '../api'
import type { BackgroundTask, Store } from '../store'

const mocks = vi.hoisted(() => ({ store: { current: null as unknown as Store } }))
// The store is four contexts now; this component reads the data half. All four
// hooks are declared even though this component reads one, because the factory
// REPLACES the module: a hook left out is a `not a function` crash the day some
// child reaches for it, and tsc cannot see into an untyped factory.
vi.mock('../store', () => {
  const store = () => mocks.store.current
  return { useStore: store, useStoreData: store, useStoreNav: store, useStoreInput: store, useStoreChat: store }
})

let container: HTMLDivElement
let root: Root

function task(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return { name: 'vault', kind: 'files', phase: 'loading', loaded: 1240, total: 3000, refreshing: false, elapsedMs: 8_200, ...patch }
}

function setStore(patch: { tasks?: BackgroundTask[]; refreshError?: LiveDataError | null; lastRefreshAt?: number | null }) {
  mocks.store.current = {
    load: {
      shell: false, concepts: false, indexingSources: [],
      tasks: patch.tasks ?? [], refreshError: patch.refreshError ?? null,
      lastRefreshAt: patch.lastRefreshAt ?? null,
    },
    retryNow: vi.fn(),
    setView: vi.fn(),
  } as unknown as Store
}

const control = () => container.querySelector<HTMLButtonElement>('.cc-activity')

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('activity summaries', () => {
  it('reads progress across every measured task and ignores the unmeasured ones', () => {
    expect(aggregatePercent([task({ loaded: 500, total: 1000 }), task({ name: 'b', loaded: 500, total: 1000 })])).toBe(50)
    expect(aggregatePercent([task({ loaded: 40, total: null })])).toBeNull()
  })

  it('names the work rather than counting it', () => {
    expect(activityLabel([task()], false)).toBe('Indexing · 41%')
    expect(activityLabel([task(), task({ name: 'notes', loaded: 0, total: 1000 })], false)).toBe('Indexing 2 sources · 31%')
    expect(activityLabel([task({ refreshing: true })], false)).toBe('Refreshing')
    expect(activityLabel([], true)).toBe('Reconnecting')
  })

  it('names the shape of the work, never its counter', () => {
    // Two tasks that differ only in progress must produce one name.
    expect(activityName([task({ loaded: 1 })], false)).toBe(activityName([task({ loaded: 2_999 })], false))
    expect(activityName([task(), task({ name: 'notes', refreshing: true })], false))
      .toBe('Background activity: indexing 1 source, refreshing 1 source')
    expect(activityName([], true)).toBe('Background activity: live refresh failing')
    expect(activityName([], false)).toBe('Background activity')
  })

  it('spells the numbers out for a screen reader', () => {
    expect(activityDescription([task()], false)).toBe('Background activity: vault reading, 1,240 of 3,000.')
    expect(activityDescription([], true)).toBe('Live refresh is failing and retrying.')
  })

  it('formats elapsed time as a wall clock', () => {
    expect(formatElapsed(8_200)).toBe('8s')
    expect(formatElapsed(64_000)).toBe('1m 04s')
  })
})

describe('BackgroundActivity', () => {
  it('renders nothing when there is nothing happening', async () => {
    setStore({})
    await act(async () => root.render(<BackgroundActivity />))
    expect(control()).toBeNull()
  })

  it('shows live progress with an accessible name, from anywhere in the shell', async () => {
    setStore({ tasks: [task()] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(control()?.textContent).toContain('Indexing · 41%')
    expect(control()?.getAttribute('aria-label')).toBe('Background activity: indexing 1 source')
    // The numbers are still one hover away; they are just not the thing a
    // screen reader is handed again on every poll.
    expect(control()?.getAttribute('title')).toContain('1,240 of 3,000')
    expect(control()?.getAttribute('aria-expanded')).toBe('false')
    expect(control()?.getAttribute('aria-haspopup')).toBe('dialog')
  })

  // A focused button whose accessible name changes gets re-announced by several
  // screen readers, and this control re-renders every 900ms for the length of
  // an index. The name must track the SHAPE of the work, not its counter.
  it('keeps the accessible name stable while progress ticks', async () => {
    setStore({ tasks: [task({ loaded: 100 })] })
    await act(async () => root.render(<BackgroundActivity />))
    const before = control()!.getAttribute('aria-label')

    setStore({ tasks: [task({ loaded: 2_900, phase: 'loading' })] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(control()!.getAttribute('aria-label')).toBe(before)

    // A real transition — a second source joining — does move it.
    setStore({ tasks: [task(), task({ name: 'notes' })] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(control()!.getAttribute('aria-label')).toBe('Background activity: indexing 2 sources')
  })

  // The engine reports a refreshing source as `ready`, so it never reaches
  // load.indexingSources and the shell's announcer never sees it. Without this,
  // a sighted user watches the control appear and a screen-reader user is told
  // nothing at all.
  it('announces a background refresh starting and finishing, and nothing in between', async () => {
    const region = () => container.querySelector('[role="status"].sr-only')
    setStore({ tasks: [] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(region()?.textContent).toBe('')

    setStore({ tasks: [task({ refreshing: true, loaded: 10, total: 100 })] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(region()?.textContent).toBe('Refreshing 1 source in the background.')

    // A tick is not a transition: the region must not be rewritten.
    setStore({ tasks: [task({ refreshing: true, loaded: 90, total: 100 })] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(region()?.textContent).toBe('Refreshing 1 source in the background.')

    setStore({ tasks: [] })
    await act(async () => root.render(<BackgroundActivity />))
    // The control retires here; the region has to outlive it or the one
    // transition worth announcing would never be spoken.
    expect(control()).toBeNull()
    expect(region()?.textContent).toBe('Background refresh finished.')
  })

  it('opens a keyboard-reachable popover with a progressbar per task, and Escape returns focus', async () => {
    setStore({ tasks: [task()], lastRefreshAt: Date.parse('2026-08-07T12:00:00Z') })
    await act(async () => root.render(<BackgroundActivity />))

    control()!.focus()
    await act(async () => control()!.click())
    const popover = document.querySelector('[role="dialog"][aria-label="Background activity"]')
    expect(popover).toBeTruthy()
    const bar = popover!.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('41')
    expect(bar?.getAttribute('aria-valuetext')).toBe('41%, 1,240 / 3,000')
    expect(popover!.textContent).toContain('Reading')
    expect(popover!.textContent).toContain('8s')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(document.querySelector('[role="dialog"][aria-label="Background activity"]')).toBeNull()
    expect(document.activeElement).toBe(control())
  })

  it('stays visible and turns attention-toned when the refresh is failing', async () => {
    const retryNow = vi.fn()
    setStore({ tasks: [], refreshError: new LiveDataError('unreachable', 'Cannot reach the ContextCake server') })
    mocks.store.current = { ...mocks.store.current, retryNow } as unknown as Store
    await act(async () => root.render(<BackgroundActivity />))

    expect(control()?.dataset.tone).toBe('attention')
    expect(control()?.textContent).toContain('Reconnecting')

    await act(async () => control()!.click())
    const popover = document.querySelector('[role="dialog"][aria-label="Background activity"]')!
    expect(popover.textContent).toContain('Cannot reach the ContextCake server')
    const retry = Array.from(popover.querySelectorAll('button')).find((b) => b.textContent === 'Retry now')
    await act(async () => retry!.click())
    expect(retryNow).toHaveBeenCalledOnce()
  })

  it('marks a refreshing source as work without claiming it has nothing to serve', async () => {
    setStore({ tasks: [task({ refreshing: true, phase: 'ready', loaded: 12, total: 12 })] })
    await act(async () => root.render(<BackgroundActivity />))
    expect(control()?.textContent).toContain('Refreshing')
    expect(control()?.textContent).not.toContain('Indexing')
  })
})

// rateLine: the "410 docs/s · ~38s left" caption — pure, so table-tested.
describe('rateLine', () => {
  const detail = (rateDocsPerSec: number | null, etaMs: number | null) =>
    ({ rateDocsPerSec, etaMs } as unknown as import('../api').IndexingActivitySource)
  it('renders rate and eta, rate alone, and nothing without a rate', () => {
    expect(rateLine(detail(410, 38_000))).toBe('410 docs/s · ~38s left')
    expect(rateLine(detail(12.5, null))).toBe('12.5 docs/s')
    expect(rateLine(detail(null, 5_000))).toBeNull()
    expect(rateLine(undefined)).toBeNull()
  })
})
