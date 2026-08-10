// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Overview } from './Overview'

const mocks = vi.hoisted(() => ({ useStore: vi.fn(), setView: vi.fn() }))
vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore, useStoreChat: mocks.useStore }))

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
  const conflict = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('actionable discrepancy'))
  await act(async () => conflict?.click())
  expect(mocks.setView).toHaveBeenCalledWith('conflicts')
})

it('shows a calm resolved state when nothing needs review', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Nothing needs review')
})

// The MCP connect entry point only exists where App.tsx wires it in (desktop
// mode) — Overview must stay silent about it otherwise rather than offering a
// dead button.
it('offers no agent-connect entry point when onConnectAgent is not supplied', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).not.toContain('Connect an agent')
})

it('surfaces a prominent Connect an agent CTA when onConnectAgent is supplied', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  const onConnectAgent = vi.fn()
  await act(async () => root.render(<Overview onConnectAgent={onConnectAgent} />))
  const cta = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Connect an agent')
  expect(cta).toBeDefined()
  await act(async () => cta?.click())
  expect(onConnectAgent).toHaveBeenCalledOnce()
})

// F3: the Cascade summary used to render the static company/team/personal
// blurb and level no matter what actually fed a lane. A level-1 source with
// no name matching its lane should read as itself — its real name and level —
// not the generic "runbooks, decisions, system docs" / "2" it happened to
// inherit from the lane it ranked into.
it('names the real source and level behind a lane instead of the static blurb', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [{ name: 'messy-vault', status: 'synced', layer: 'team', level: 1, conceptCount: 4 }],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('messy-vault')
  expect(container.textContent).toContain('1')
  expect(container.textContent).not.toContain('runbooks, decisions, system docs')
})

// Demo mode's sources are already the canonical trio; the honest-labeling
// pass must not disturb its existing static blurb.
it('keeps the static cascade blurb in demo mode', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'demo', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [{ name: 'team', status: 'synced', layer: 'team', level: 2, conceptCount: 4 }],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('runbooks, decisions, system docs')
})
