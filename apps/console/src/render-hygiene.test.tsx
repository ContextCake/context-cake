// @vitest-environment jsdom
// Two properties that are invisible in a functional test and were both false of
// the shell before this suite existed: a sidebar drag wrote a preference on
// every pointermove (an IPC round trip that the desktop main process answered
// with a synchronous settings read-write-rename), and a keystroke in the
// toolbar search re-rendered the entire tree.
//
// Renders are counted through the leaf icons each component renders INLINE —
// one render of the parent is one render of the icon. `React.Profiler` was
// tried first and does not work here: onRender is not called for a subtree
// re-rendered by context propagation, so it reported zero either way.
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { ChatPanel } from './components/ChatPanel'
import { StoreProvider } from './store'
import { SEARCHABLE_VIEWS, type ViewId } from './shell-navigation'
import { Concepts } from './views/Concepts'
import { Conflicts } from './views/Conflicts'
import { Files } from './views/Files'
import { Sources } from './views/Sources'
import { Triage } from './views/Triage'

type AnyComponent = (props: Record<string, unknown>) => unknown

const renders: Record<string, number> = {}

vi.mock('./components/icons', async () => {
  const actual = await vi.importActual<Record<string, ComponentType<never>>>('./components/icons')
  const counted: Record<string, unknown> = {}
  for (const [name, Component] of Object.entries(actual)) {
    counted[name] = (props: Record<string, unknown>) => {
      renders[name] = (renders[name] ?? 0) + 1
      return (Component as unknown as AnyComponent)(props)
    }
  }
  return counted
})

// The views render no icons, so they need a leaf of their own. `LayerChip` is
// what Concepts renders inline on every row — unmemoized, so one render of the
// view is at least one render of the chip.
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

/** jsdom has no PointerEvent; the resizer only reads button/clientX/pointerId. */
function pointer(kind: string, clientX: number): PointerEvent {
  const event = new MouseEvent(kind, { bubbles: true, button: 0, clientX }) as unknown as PointerEvent
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
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
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
  for (const key of Object.keys(renders)) delete renders[key]
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (window as unknown as Record<string, unknown>).__CC_DESKTOP
  window.location.hash = ''
})

describe('render hygiene', () => {
  it('persists a sidebar drag once, not once per frame', () => {
    vi.useFakeTimers()
    const set = vi.fn(() => Promise.resolve({}))
    ;(window as unknown as Record<string, unknown>).__CC_DESKTOP = {
      uiState: {
        initial: {
          sidebar: { collapsed: false, width: 232 }, lastView: 'overview',
          knowledgeView: 'concepts', reviewView: 'triage', settingsPane: 'general',
        },
        set,
      },
    }
    act(() => root.render(<StoreProvider><Sidebar /></StoreProvider>))
    const handle = container.querySelector<HTMLElement>('.cc-sidebar-resizer')
    expect(handle).toBeTruthy()

    act(() => { handle!.dispatchEvent(pointer('pointerdown', 232)) })
    // 120 Hz for two seconds — a real trackpad drag.
    for (let frame = 0; frame < 240; frame += 1) {
      act(() => {
        window.dispatchEvent(pointer('pointermove', 232 + (frame % 60)))
        vi.advanceTimersByTime(1000 / 120)
      })
    }
    act(() => { window.dispatchEvent(pointer('pointermove', 276)) })
    act(() => { window.dispatchEvent(pointer('pointerup', 276)) })
    act(() => { vi.advanceTimersByTime(1000) })

    const patches = (set.mock.calls as unknown as { sidebar?: { width: number } }[][])
      .map((call) => call[0])
      .filter((patch) => patch?.sidebar !== undefined)
    // One write, on pointer-up. Undebounced this was 240.
    expect(patches).toHaveLength(1)
    // And it is where the drag ENDED, not some frame in the middle.
    expect(patches[0]?.sidebar?.width).toBe(276)
  })

  it('does not re-render the sidebar while the user types in the toolbar search', () => {
    window.location.hash = '#/concepts'
    act(() => root.render(
      <StoreProvider>
        <Sidebar />
        <Header onToggleSidebar={() => {}} onAsk={() => {}} />
      </StoreProvider>,
    ))
    const input = container.querySelector<HTMLInputElement>('input[data-context-search]')
    expect(input).toBeTruthy()

    const sidebarBefore = renders.SettingsIcon ?? 0
    const headerBefore = renders.SparkleIcon ?? 0
    for (const text of ['p', 'po', 'pos', 'post', 'postg']) typeInto(input!, text)

    // The header owns the field and has to repaint; five characters, five
    // renders. The sidebar has nothing to say about a query and sits them out.
    expect((renders.SparkleIcon ?? 0) - headerBefore).toBe(5)
    expect((renders.SettingsIcon ?? 0) - sidebarBefore).toBe(0)
  })
})

/**
 * The other half of the render budget, and the half that shipped broken.
 *
 * The suite above measures what must NOT repaint. On its own it is satisfiable
 * by a component that never repaints at all: `Triage` subscribed to the data and
 * nav contexts only, read the query indirectly through a `filtered()` callback
 * with an empty dependency array, and so sat out every keystroke — the Queue
 * silently stopped filtering and the negative assertion stayed green, because it
 * only ever rendered the sidebar and the header.
 *
 * So this pairs it: for every view the shell offers a search box, typing a query
 * nothing can match has to actually empty the list. The case table is checked
 * against SEARCHABLE_VIEWS itself, so adding a searchable view without teaching
 * it to react to a keystroke fails here rather than in the field.
 */
const NO_MATCH = 'zzzzznomatchzzzzz'

/** `rows` names the list this view filters — the thing a query has to shrink. */
const SEARCH_CASES: { view: ViewId; Component: ComponentType; rows: string }[] = [
  // Signal cards; the decision panel beside them uses h2.
  { view: 'triage', Component: Triage, rows: 'h3' },
  { view: 'concepts', Component: Concepts, rows: '.cc-navigator-detail > div > button.cc-h-bd-strong' },
  { view: 'conflicts', Component: Conflicts, rows: '.cc-conflict-list > button[role="option"]' },
  { view: 'sources', Component: Sources, rows: 'button[role="option"]' },
  { view: 'files', Component: Files, rows: '[role="treeitem"]' },
]

async function mountView(view: ViewId, Component: ComponentType, { chat = false } = {}) {
  window.location.hash = `#/${view}`
  await act(async () => root.render(
    <StoreProvider>
      <Header onToggleSidebar={() => {}} onAsk={() => {}} />
      <Component />
      {chat && <ChatPanel onClose={() => {}} />}
    </StoreProvider>,
  ))
  // The demo bundle resolves through a promise chain; let it land.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('a search keystroke reaches the view', () => {
  it('covers every view the shell offers a search box for', () => {
    expect(new Set(SEARCH_CASES.map((entry) => entry.view))).toEqual(SEARCHABLE_VIEWS)
  })

  for (const { view, Component, rows } of SEARCH_CASES) {
    it(`filters ${view} down to nothing on a query that matches nothing`, async () => {
      await mountView(view, Component)
      const input = container.querySelector<HTMLInputElement>('input[data-context-search]')
      expect(input, `${view} is searchable but the toolbar rendered no search field`).toBeTruthy()

      const before = container.querySelectorAll(rows).length
      // A view with nothing in it cannot demonstrate filtering, and a selector
      // that has drifted off its rows would silently pass every assertion below.
      expect(before, `${view} rendered no rows to filter — the fixture or the selector is wrong`).toBeGreaterThan(0)
      const textBefore = container.textContent

      typeInto(input!, NO_MATCH)

      expect(container.querySelectorAll(rows).length).toBe(0)
      expect(container.textContent).not.toBe(textBefore)
    })
  }
})

/**
 * The chat composer is the second thing a user types into, and the one the
 * split above did not cover: it lives in a slide-over rendered OVER the active
 * view, and the view has nothing to say about it. While `chatInput` shared a
 * context with `query`, every character of a question repainted whichever view
 * happened to be underneath.
 *
 * Both halves are asserted for the same reason the search suite pairs its own:
 * "the view did not re-render" is trivially satisfiable by a composer that
 * stopped updating, and "the composer updated" says nothing about the tree
 * beneath it.
 */
describe('a chat keystroke stays inside the chat', () => {
  it('leaves the view under the panel alone, while a search keystroke still reaches it', async () => {
    await mountView('concepts', Concepts, { chat: true })
    const composer = container.querySelector<HTMLTextAreaElement>('.cc-ask-panel textarea')
    expect(composer, 'the chat panel rendered no composer').toBeTruthy()
    const search = container.querySelector<HTMLInputElement>('input[data-context-search]')
    expect(search, 'the toolbar rendered no search field').toBeTruthy()
    // Typed into the search box below. Taken off the view so the assertion
    // does not depend on what the demo fixture happens to be called.
    const conceptId = container.querySelector('.cc-navigator-detail > div > button.cc-h-bd-strong code')?.textContent
    expect(conceptId, 'the view rendered no concept rows').toBeTruthy()

    const before = renders.LayerChip ?? 0
    expect(before, 'the view rendered no layer chips — the probe is counting nothing').toBeGreaterThan(0)
    for (const text of ['w', 'wh', 'wha', 'what']) typeInto(composer!, text)

    // The composer is live: four characters, and it holds all four.
    expect(composer!.value).toBe('what')
    // And the view underneath sat every one of them out.
    expect((renders.LayerChip ?? 0) - before).toBe(0)

    // The other half — the same view still repaints for the box that IS its own.
    const beforeSearch = renders.LayerChip ?? 0
    typeInto(search!, conceptId!)
    expect(renders.LayerChip ?? 0).toBeGreaterThan(beforeSearch)
  })
})
