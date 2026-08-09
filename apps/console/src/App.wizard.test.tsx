// @vitest-environment jsdom
// The setup wizard's dialog contract (F25, F26): closing it returns focus to
// whatever opened it, and the app shell behind it is inert while it is open —
// the same contract Settings already had. Live-shaped data source so the
// wizard opens in "add a source" mode (one source already present) rather
// than the first-run narrative.
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

function readyGraph() {
  return {
    totals: { sourceTokens: 0, resolvedTokens: 0, concepts: 0, sources: 1 },
    indexing: false,
    indexingSources: [],
    generation: 1,
    sources: [{
      name: 'personal', level: 3, kind: 'files', conceptCount: 0, tokens: 0, latestUpdated: null,
      status: 'ok', error: null,
    }],
    concepts: [],
  }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
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
  mocks.graph.mockResolvedValue(readyGraph())
  mocks.resolveAll.mockResolvedValue({ concepts: [], errors: [], indexing: false })
  mocks.conflictResolutions.mockResolvedValue([])
  mocks.status.mockResolvedValue(null)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the setup wizard as a dialog', () => {
  it('inerts the app shell while open, and lifts it once closed', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const opener = button('Add Source')
    opener.focus()
    await act(async () => opener.click())

    expect(container.querySelector('[aria-label="ContextCake setup"]')).toBeTruthy()
    expect(container.querySelector('.cc-app-layer')?.hasAttribute('inert')).toBe(true)

    await act(async () => button('Cancel').click())
    expect(container.querySelector('[aria-label="ContextCake setup"]')).toBeNull()
    expect(container.querySelector('.cc-app-layer')?.hasAttribute('inert')).toBe(false)
  })

  it('restores focus to the button that opened it', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const opener = button('Add Source')
    opener.focus()
    await act(async () => opener.click())
    expect(container.querySelector('[aria-label="ContextCake setup"]')).toBeTruthy()

    await act(async () => button('Cancel').click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(opener)
  })

  it('closes on Escape and still restores focus to the opener', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const opener = button('Add Source')
    opener.focus()
    await act(async () => opener.click())

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    expect(container.querySelector('[aria-label="ContextCake setup"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
