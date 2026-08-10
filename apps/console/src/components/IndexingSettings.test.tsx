// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexingSettings } from './IndexingSettings'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))

let container: HTMLDivElement
let root: Root

const CATALOG = [
  { key: 'maxDocFiles', label: 'Maximum documents per source', help: 'How many files ContextCake will index in one folder.', min: 100, max: 2000000, default: 10000 },
  { key: 'sourceBudgetMs', label: 'Time budget per source', help: 'How long one source may take to index.', min: 1000, max: 600000, default: 30000 },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const payload = (settings: Record<string, number>, stored: Record<string, number> = {}) =>
  json({ settings: { maxDocFiles: 10000, sourceBudgetMs: 30000, ...settings }, stored, catalog: CATALOG })

function field(key: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#cc-set-${key}`)
  if (!input) throw new Error(`Field not found: ${key}`)
  return input
}

// React's onBlur is delegated from `focusout` — a plain `blur` event does not
// bubble and never reaches the handler.
function blur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.apiFetch.mockReset()
  mocks.apiFetch.mockImplementation(async () => payload({}))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('IndexingSettings', () => {
  it('shows the effective limits with plain-language help', async () => {
    await act(async () => root.render(<IndexingSettings />))

    expect(field('maxDocFiles').value).toBe('10000')
    expect(container.textContent).toContain('How many files ContextCake will index in one folder.')
  })

  it('saves a changed limit on blur', async () => {
    const onChanged = vi.fn()
    await act(async () => root.render(<IndexingSettings onChanged={onChanged} />))
    mocks.apiFetch.mockImplementation(async () => payload({ maxDocFiles: 50000 }, { maxDocFiles: 50000 }))

    await type(field('maxDocFiles'), '50000')
    await act(async () => blur(field('maxDocFiles')))

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ maxDocFiles: 50000 }),
    }))
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('rejects an out-of-range value in the form without calling the server', async () => {
    await act(async () => root.render(<IndexingSettings />))
    mocks.apiFetch.mockClear()

    await type(field('maxDocFiles'), '5')
    await act(async () => blur(field('maxDocFiles')))

    expect(container.textContent).toContain('between')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('surfaces a server rejection rather than showing a value that was not saved', async () => {
    await act(async () => root.render(<IndexingSettings />))
    mocks.apiFetch.mockImplementation(async () => json({ error: 'Maximum documents per source must be between 100 and 2,000,000' }, 400))

    await type(field('maxDocFiles'), '900')
    await act(async () => blur(field('maxDocFiles')))

    expect(container.textContent).toContain('must be between')
  })

  it('offers Reset only for a value the user has changed', async () => {
    mocks.apiFetch.mockImplementation(async () => payload({ maxDocFiles: 50000 }, { maxDocFiles: 50000 }))
    await act(async () => root.render(<IndexingSettings />))

    const resets = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Reset')
    expect(resets).toHaveLength(1) // only maxDocFiles is stored

    mocks.apiFetch.mockImplementation(async () => payload({}))
    await act(async () => resets[0].click())
    // null clears the stored value, returning the setting to its default.
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      body: JSON.stringify({ maxDocFiles: null }),
    }))
  })

  it('explains when the engine is unreachable instead of showing blank fields', async () => {
    mocks.apiFetch.mockImplementation(async () => json({ error: 'nope' }, 500))
    await act(async () => root.render(<IndexingSettings />))

    expect(container.textContent).toContain('running ContextCake engine')
  })

  it('labels a millisecond setting with a minutes/hours picker and a human-scale reading, and leaves a count setting alone', async () => {
    await act(async () => root.render(<IndexingSettings />))

    // sourceBudgetMs (30000 in the default payload, sub-minute): edited in
    // minutes, so the field shows 0.5, next to a unit <select> (not a plain "ms" label).
    const unitSelect = field('sourceBudgetMs').nextElementSibling as HTMLSelectElement
    expect(unitSelect.tagName).toBe('SELECT')
    expect(unitSelect.value).toBe('min')
    expect(field('sourceBudgetMs').value).toBe('0.5')
    expect(container.textContent).toContain('30000 ms = 30 sec')

    // maxDocFiles is a count, not a duration — no unit, no invented reading.
    expect(field('maxDocFiles').nextElementSibling).toBeNull()
    expect(container.textContent).not.toContain('10000 ms')
  })

  it('updates the human-scale reading as the field is edited, converting from the displayed unit to ms', async () => {
    await act(async () => root.render(<IndexingSettings />))

    // Typed in minutes (the field's unit): 2 min => 120000 ms underneath.
    await type(field('sourceBudgetMs'), '2')
    expect(container.textContent).toContain('120000 ms = 2 min')
  })
})
