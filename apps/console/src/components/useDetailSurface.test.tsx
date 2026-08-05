// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDetailSurface } from './useDetailSurface'

let container: HTMLDivElement
let root: Root
let width = 700

function Fixture({ open = true }: { open?: boolean }) {
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(open)
  return <div ref={detail.containerRef}>
    <section ref={detail.panelRef} {...detail.panelProps} aria-label="Fixture detail">
      <button type="button">Close</button>
      <button type="button">Last action</button>
    </section>
  </div>
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  width = 700
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width, height: 500, x: 0, y: 0, top: 0, right: width, bottom: 500, left: 0, toJSON: () => ({}),
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('useDetailSurface', () => {
  it('uses modal semantics and traps focus only in a narrow workspace', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    await act(async () => root.render(<Fixture />))
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const panel = container.querySelector<HTMLElement>('section')!
    const [first, last] = Array.from(panel.querySelectorAll<HTMLButtonElement>('button'))
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(first)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })

    last.focus()
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(first)

    width = 900
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(panel.getAttribute('role')).toBe('complementary')
    expect(panel.hasAttribute('aria-modal')).toBe(false)
  })
})
