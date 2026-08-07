// @vitest-environment jsdom
// The shell's honesty contract, at the component level: what the toolbar says
// while the engine is working, and what it says when it has stopped being able
// to ask. Both were previously unrepresentable — a bare "Indexing 2" badge with
// no progress, and, for a failing refresh, nothing at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityDescription, activityLabel, aggregatePercent, BackgroundActivity, formatElapsed } from './BackgroundActivity'
import { LiveDataError } from '../api'
import type { BackgroundTask, Store } from '../store'

const mocks = vi.hoisted(() => ({ store: { current: null as unknown as Store } }))
vi.mock('../store', () => ({ useStore: () => mocks.store.current }))

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
    expect(control()?.getAttribute('aria-label')).toContain('1,240 of 3,000')
    expect(control()?.getAttribute('aria-expanded')).toBe('false')
    expect(control()?.getAttribute('aria-haspopup')).toBe('dialog')
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
