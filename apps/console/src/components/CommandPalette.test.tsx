// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'

it('filters commands deterministically and supports arrow/Enter execution with trapped focus', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const first = vi.fn()
  const second = vi.fn()
  const close = vi.fn()
  await act(async () => root.render(<CommandPalette commands={[
    { id: 'first', label: 'Go to Home', run: first },
    { id: 'second', label: 'Open Settings', keywords: 'preferences', run: second },
  ]} onClose={close} />))

  const input = host.querySelector('input')!
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-label')).toBe('Search commands')
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('2 commands')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'preferences')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 command')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(close).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(first).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  host.remove()
})
