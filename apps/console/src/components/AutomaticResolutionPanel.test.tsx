// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutomaticResolutionPanel } from './AutomaticResolutionPanel'
import type { Conflict } from '../data'
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), reload: vi.fn() }))
vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../store', () => ({ useStoreData: () => ({ reload: mocks.reload, reloadKey: 0 }) }))
let root: Root
let container: HTMLDivElement
const conflict: Conflict = { id: 'd1', concept: 'decisions/db', sectionKey: 'choice', section: 'Choice', title: 'Database', kind: 'section_content', revision: 'rev1', status: 'open', safe: true, winner: 'personal', history: [], contributions: [{ layer: 'personal', sourceLayer: 'project-docs', value: 'Use PostgreSQL.', updated: '2026-01-01' }] }
const initial = { version: 1, revision: 'state1', policies: [], decisions: [] }
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)! }
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiFetch.mockReset(); mocks.reload.mockReset()
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify(initial)))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
it('requires a source choice and explains the exact standing policy before enabling', async () => {
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify(initial)))
  await act(async () => root.render(<AutomaticResolutionPanel conflict={conflict} />))
  await act(async () => button('Manage policies').click())
  expect(button('Enable this source policy').disabled).toBe(true)
  const select = container.querySelector('select')!
  await act(async () => { select.value = 'project-docs'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.textContent).toContain('now and on future changes, without another approval')
  expect(container.textContent).toContain('Use PostgreSQL.')
  await act(async () => button('Enable this source policy').click())
  const call = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(call[1].body)).toEqual({ conceptId: 'decisions/db', key: 'choice', selectedSource: 'project-docs', revision: 'rev1' })
  expect(mocks.reload).toHaveBeenCalledOnce()
})
it('does not claim success when the engine rejects stale evidence', async () => {
  mocks.apiFetch.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method ? { error: 'Evidence changed; review the new version.' } : initial), { status: init?.method ? 409 : 200 }))
  await act(async () => root.render(<AutomaticResolutionPanel conflict={conflict} />))
  await act(async () => button('Manage policies').click())
  const select = container.querySelector('select')!
  await act(async () => { select.value = 'project-docs'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('Enable this source policy').click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Evidence changed')
  expect(container.textContent).not.toContain('Source policy enabled.')
  expect(mocks.reload).not.toHaveBeenCalled()
})
it('keeps original decisions visible and limits Undo to the latest decision per section', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ...initial, policies: [{ id: 'p1', conceptId: 'decisions/db', key: 'choice', selectedSource: 'project-docs', enabled: false, version: 1 }], decisions: ['old', 'latest'].map((id) => ({ id, conceptId: 'decisions/db', key: 'choice', selectedSource: 'project-docs', createdAt: '2026-09-06T00:00:00Z' })) })))
  await act(async () => root.render(<AutomaticResolutionPanel conflict={null} />))
  await act(async () => button('Manage policies').click())
  expect(container.textContent).toContain('Paused')
  expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Undo')).toHaveLength(1)
})
