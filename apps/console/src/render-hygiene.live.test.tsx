// @vitest-environment jsdom
// The render-budget suite next door mounts the store in demo mode, because that
// is what `createDataSource()` picks with no query string. Demo mode is also the
// only mode in which the provider's `activity` is a stable module constant — in
// live mode it was a fresh `[]` on every provider render, which changed the
// identity of the whole `data` context every time ANY provider state moved.
//
// That defeated the context split outright: `App` subscribes to `data` and owns
// every memoized child, so a keystroke repainted the tree in exactly the mode
// the Mac app ships in, while the suite next door measured zero and passed.
//
// So this file pins the same properties with the store in live mode. It is a
// separate file because `vi.mock` is per-file and the suite next door must stay
// on the demo path.
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Header } from './components/Header'
import { ChatPanel } from './components/ChatPanel'
import { StoreProvider, useStoreData } from './store'
import { Concepts } from './views/Concepts'

type AnyComponent = (props: Record<string, unknown>) => unknown

const renders: Record<string, number> = {}

// A live-mode source that still answers from the demo bundle. The mode flag is
// the whole variable under test: the payloads are identical either way, and
// swapping in a real LiveSource would only measure jsdom's missing network.
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    createDataSource: () => new Proxy(actual.createDataSource('demo'), {
      get: (target, key) => (key === 'mode' ? 'live' : Reflect.get(target, key, target)),
    }),
  }
})

vi.mock('./components/LayerChip', async () => {
  const actual = await vi.importActual<Record<string, ComponentType<never>>>('./components/LayerChip')
  return {
    LayerChip: (props: Record<string, unknown>) => {
      renders.LayerChip = (renders.LayerChip ?? 0) + 1
      return (actual.LayerChip as unknown as AnyComponent)(props)
    },
  }
})

let container: HTMLDivElement
let root: Root

/**
 * Stands in for `App`: subscribes to `data` and nothing else. App owns every
 * memoized child in the shell, so one render of this is one render of the tree
 * — and unlike App it drags in no routing, no wizard and no IPC.
 */
function DataConsumerProbe() {
  useStoreData()
  renders.probe = (renders.probe ?? 0) + 1
  return null
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = field instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const key of Object.keys(renders)) delete renders[key]
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.location.hash = ''
})

describe('the render budget holds in live mode too', () => {
  it('keeps a keystroke off the data context, in either typing surface', async () => {
    window.location.hash = '#/concepts'
    await act(async () => root.render(
      <StoreProvider>
        <DataConsumerProbe />
        <Header onToggleSidebar={() => {}} onAsk={() => {}} />
        <Concepts />
        <ChatPanel onClose={() => {}} />
      </StoreProvider>,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const composer = container.querySelector<HTMLTextAreaElement>('.cc-ask-panel textarea')
    expect(composer, 'the chat panel rendered no composer').toBeTruthy()
    const search = container.querySelector<HTMLInputElement>('input[data-context-search]')
    expect(search, 'the toolbar rendered no search field').toBeTruthy()
    const conceptId = container.querySelector('.cc-navigator-detail > div > button.cc-h-bd-strong code')?.textContent
    expect(conceptId, 'the view rendered no concept rows — live mode served nothing').toBeTruthy()

    const chipsBefore = renders.LayerChip ?? 0
    const probeBefore = renders.probe ?? 0
    expect(chipsBefore, 'the view rendered no layer chips — the probe is counting nothing').toBeGreaterThan(0)
    expect(probeBefore, 'the data probe never rendered').toBeGreaterThan(0)

    // A question typed over the top of a view touches neither the view nor the
    // shell that hosts it.
    for (const text of ['w', 'wh', 'wha', 'what']) typeInto(composer!, text)
    expect(composer!.value).toBe('what')
    expect((renders.LayerChip ?? 0) - chipsBefore).toBe(0)
    expect((renders.probe ?? 0) - probeBefore).toBe(0)

    // And a search keystroke reaches the view it filters — without repainting
    // the shell, which is the property the original context split bought.
    const chipsBeforeSearch = renders.LayerChip ?? 0
    const probeBeforeSearch = renders.probe ?? 0
    typeInto(search!, conceptId!)
    expect(renders.LayerChip ?? 0).toBeGreaterThan(chipsBeforeSearch)
    expect((renders.probe ?? 0) - probeBeforeSearch).toBe(0)
  })
})
