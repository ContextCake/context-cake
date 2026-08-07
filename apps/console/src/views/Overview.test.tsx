// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Overview } from './Overview'

const mocks = vi.hoisted(() => ({ useStore: vi.fn(), setView: vi.fn() }))
vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.setView.mockReset()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('prioritizes actionable work and never renders fixture activity in live mode', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [{ id: 'q', route: 'review_required' }],
    conflicts: [{ id: 'c', status: 'open', contributions: [] }],
    sources: [{ name: 'docs', status: 'error', error: 'Source failed exactly', layer: 'team', conceptCount: 0 }],
    concepts: [], activity: [{ strong: 'fixture should not render' }],
    loadErrors: [{ concept: 'x', error: 'partial' }],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Needs Attention')
  expect(container.textContent).toContain('Source failed exactly')
  expect(container.textContent).not.toContain('fixture should not render')
  const conflict = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('open conflict'))
  await act(async () => conflict?.click())
  expect(mocks.setView).toHaveBeenCalledWith('conflicts')
})

it('shows a calm resolved state when nothing needs review', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Nothing needs review')
})
