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
//
// ONE INVARIANT HOLDS THESE TESTS UP: every window between capturing a baseline
// count and asserting on it must stay synchronous. Live mode really does arm
// the poll loop (one 5s timer per test, cleared on unmount), and a poll that
// landed mid-window would legitimately move the numbers — `setLastRefreshAt`
// feeds `load`, and `load` is a dependency of the `data` memo. No poll can
// interleave with straight-line code, which is why the counts are exact today.
// Add an `await` between a baseline and its assertion and this becomes a
// five-second timing flake that CI will find long before you do.
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { Header } from './components/Header'
import { ChatPanel } from './components/ChatPanel'
import { StoreProvider, useStoreData } from './store'
import { ThemeModeProvider } from './theme-mode'
import { Concepts } from './views/Concepts'

type AnyComponent = (props: Record<string, unknown>) => unknown

const renders: Record<string, number> = {}

// A live-mode source that still answers from the demo bundle. The mode flag is
// the whole variable under test: the payloads are identical either way, and
// swapping in a real LiveSource would only measure jsdom's missing network.
//
// The Proxy returns unbound methods, which then run with `this` set to the
// proxy. That resolves only because DemoSource's fields are TypeScript
// `private` — a compile-time marker over an ordinary property, so `this.bundle`
// re-enters the trap and finds the target's value. Convert one of them to a
// real `#private` field and every call through here throws, surfacing as the
// store's generic `refreshError` rather than as an obvious test failure. Bind
// to the target here if that day comes.
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    createDataSource: () => new Proxy(actual.createDataSource('demo'), {
      get: (target, key) => (key === 'mode' ? 'live' : Reflect.get(target, key, target)),
    }),
  }
})

/** Render counter inside the memo boundary — see the note in render-hygiene.test.tsx. */
async function counted(name: string, actual: Record<string, unknown>) {
  const { memo } = await import('react')
  const exported = actual[name]
  const wasMemo = typeof exported !== 'function'
  const Inner = (wasMemo ? (exported as { type: unknown }).type : exported) as AnyComponent
  const Counted = (props: Record<string, unknown>) => {
    renders[name] = (renders[name] ?? 0) + 1
    return Inner(props)
  }
  return { ...actual, [name]: wasMemo ? memo(Counted as unknown as ComponentType) : Counted }
}

vi.mock('./views/Concepts', async () => counted('Concepts', await vi.importActual('./views/Concepts')))
vi.mock('./App', async () => counted('App', await vi.importActual('./App')))

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
  // This suite measures the connected live composer. Unconnected live mode
  // intentionally renders connection guidance instead of a fake input.
  window.claude = { complete: vi.fn().mockResolvedValue('answer') }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete window.claude
  window.history.replaceState(null, '', '/')
  document.documentElement.removeAttribute('data-theme')
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

    const viewBefore = renders.Concepts ?? 0
    const probeBefore = renders.probe ?? 0
    expect(viewBefore, 'the view never rendered — the probe is counting nothing').toBeGreaterThan(0)
    expect(probeBefore, 'the data probe never rendered').toBeGreaterThan(0)

    // A question typed over the top of a view touches neither the view nor the
    // shell that hosts it.
    for (const text of ['w', 'wh', 'wha', 'what']) typeInto(composer!, text)
    expect(composer!.value).toBe('what')
    expect((renders.Concepts ?? 0) - viewBefore).toBe(0)
    expect((renders.probe ?? 0) - probeBefore).toBe(0)

    // And a search keystroke reaches the view it filters — without repainting
    // the shell, which is the property the original context split bought.
    const viewBeforeSearch = renders.Concepts ?? 0
    const probeBeforeSearch = renders.probe ?? 0
    typeInto(search!, conceptId!)
    expect(renders.Concepts ?? 0).toBeGreaterThan(viewBeforeSearch)
    expect((renders.probe ?? 0) - probeBeforeSearch).toBe(0)
  })

  /**
   * The probe above stands in for `App`'s data subscription, which is what this
   * bug traveled through — but it is a stand-in, and it cannot see a NEW
   * subscription added to the real App. Adding `useStoreChat()` there would
   * repaint the shell's own inline JSX on every character and leave the suite
   * green, because every child it renders is memoized and would bail.
   *
   * So this mounts the real thing and opens the panel the way a user does.
   */
  it('does not re-render the shell itself while a question is typed into it', async () => {
    window.history.replaceState(null, '', '/#/concepts')
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    await act(async () => root.render(
      <ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const ask = container.querySelector<HTMLButtonElement>('.cc-toolbar-ask')
    expect(ask, 'the toolbar rendered no Ask button').toBeTruthy()
    await act(async () => { ask!.click() })
    const composer = container.querySelector<HTMLTextAreaElement>('.cc-ask-panel textarea')
    expect(composer, 'clicking Ask opened no composer').toBeTruthy()

    const before = renders.App ?? 0
    expect(before, 'the shell never rendered — the probe is counting nothing').toBeGreaterThan(0)
    for (const text of ['w', 'wh', 'wha', 'what']) typeInto(composer!, text)
    expect(composer!.value).toBe('what')
    expect((renders.App ?? 0) - before).toBe(0)
  })
})
