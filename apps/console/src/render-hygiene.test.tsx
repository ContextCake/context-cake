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
import { StoreProvider } from './store'

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

let container: HTMLDivElement
let root: Root

/** jsdom has no PointerEvent; the resizer only reads button/clientX/pointerId. */
function pointer(kind: string, clientX: number): PointerEvent {
  const event = new MouseEvent(kind, { bubbles: true, button: 0, clientX }) as unknown as PointerEvent
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
