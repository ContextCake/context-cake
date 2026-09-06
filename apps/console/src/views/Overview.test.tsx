// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Overview } from './Overview'

const mocks = vi.hoisted(() => ({ useStore: vi.fn(), setView: vi.fn(), openConcept: vi.fn(), openConceptSearch: vi.fn() }))
vi.mock('../store', () => ({ useStoreData: mocks.useStore }))
let container: HTMLDivElement
let root: Root
const source = (name = 'project', level = 3) => ({ name, level, layer: 'personal', status: 'synced', conceptCount: 12, sourceKind: 'files' })
const concept = (id: string, updated?: string) => ({ id, title: id, type: 'note', layers: ['personal'], contributorLayers: ['project'], sections: updated ? [{ name: 'Context', updated, sourceLayer: 'project', winner: 'personal', value: 'Evidence' }] : [] })
function store(extra = {}) { return { mode: 'live', setView: mocks.setView, openConcept: mocks.openConcept, openConceptSearch: mocks.openConceptSearch, signals: [], conflicts: [], sources: [source()], concepts: [], loadErrors: [], activity: [], ...extra } }
const button = (text: string) => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text))!
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('leads with search and preserves the submitted query and shortcut actions', async () => {
  mocks.useStore.mockReturnValue(store())
  await act(async () => root.render(<Overview />))
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search your project context"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'build and test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(mocks.openConceptSearch).toHaveBeenCalledWith('build and test')
  await act(async () => button('architecture').click())
  expect(mocks.openConceptSearch).toHaveBeenLastCalledWith('architecture')
  expect(container.querySelector('.cc-metric-strip')).toBeNull()
})

it('orders only real known section dates and opens the actual document', async () => {
  mocks.useStore.mockReturnValue(store({ concepts: [concept('older', '2026-01-01'), concept('undated'), concept('latest', '2026-08-20'), { ...concept('compact', '2026-09-01'), detailLoaded: false }, concept('invalid', 'not-a-date')] }))
  await act(async () => root.render(<Overview />))
  const rows = Array.from(container.querySelectorAll('.cc-workspace-document-list li'))
  expect(rows).toHaveLength(5)
  expect(rows[0].textContent).toContain('latest')
  expect(rows[0].querySelector('time')?.dateTime).toBe('2026-08-20')
  expect(rows[1].textContent).toContain('older')
  expect(rows.slice(2).map((row) => row.querySelector('time'))).toEqual([null, null, null])
  await act(async () => rows[0].querySelector('button')!.click())
  expect(mocks.openConcept).toHaveBeenCalledWith('latest')
})

it('fills six library places with undated documents after known updates without duplicating dated entries', async () => {
  mocks.useStore.mockReturnValue(store({ concepts: [concept('old', '2026-01-01'), ...Array.from({ length: 10 }, (_, i) => concept(`doc-${i}`)), concept('new', '2026-08-20')] }))
  await act(async () => root.render(<Overview />))
  const titles = Array.from(container.querySelectorAll('.cc-workspace-document-copy strong')).map((title) => title.textContent)
  expect(titles).toEqual(['new', 'old', 'doc-0', 'doc-1', 'doc-2', 'doc-3'])
  expect(container.querySelectorAll('time')).toHaveLength(2)
  expect(container.textContent).toContain('Available documents, with known section dates.')
})

it('shows bounded indexed context without inventing dates or viewing history', async () => {
  mocks.useStore.mockReturnValue(store({ concepts: Array.from({ length: 100 }, (_, i) => ({ ...concept(`doc-${i}`), detailLoaded: false })), activity: [{ strong: 'Fake recent visit' }] }))
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('From your library')
  expect(container.querySelectorAll('.cc-workspace-document-list li')).toHaveLength(6)
  expect(container.querySelector('time')).toBeNull()
  expect(container.textContent).not.toContain('Recently updated')
  expect(container.textContent).not.toContain('Fake recent visit')
})

it('prioritizes actionable discrepancies and preserves queue and partial failure routes', async () => {
  mocks.useStore.mockReturnValue(store({ signals: [{ route: 'review_required' }], conflicts: [{ id: 'c', status: 'open', kind: 'broken_link', discrepancyStatus: 'needs_review', contributions: [] }, { id: 'done', status: 'resolved', kind: 'section_content', discrepancyStatus: 'resolved', contributions: [] }], sources: [{ ...source(), status: 'error', error: 'Source failed exactly' }], loadErrors: [{ error: 'partial' }] }))
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('1 discrepancy needs review')
  expect(container.textContent).toContain('1 broken link')
  expect(container.textContent).toContain('Source failed exactly')
  expect(container.textContent).toContain('1 document could not be resolved')
  await act(async () => button('Review discrepancies').click())
  expect(mocks.setView).toHaveBeenLastCalledWith('conflicts')
  await act(async () => button('waiting in Queue').click())
  expect(mocks.setView).toHaveBeenLastCalledWith('triage')
})

it.each([{ status: 'indexing' }, { status: 'degraded' }, { warnings: 2 }, { indexing: { refreshing: true } }])('never claims complete context while source health is partial: %j', async (state) => {
  mocks.useStore.mockReturnValue(store({ sources: [{ ...source(), ...state }] }))
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Your context is incomplete')
  expect(container.textContent).not.toContain('No open discrepancies')
  expect(container.textContent).toContain('may limit coverage')
})

it('distinguishes a failing refresh from settled context', async () => {
  mocks.useStore.mockReturnValue(store({ load: { refreshError: { message: 'offline' } } }))
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Updates are unavailable')
  expect(container.textContent).not.toContain('No open discrepancies')
})

it('shows settled review status with a working route to Trust', async () => {
  mocks.useStore.mockReturnValue(store())
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('No open discrepancies')
  expect(container.textContent).toContain('Recorded decisions and source evidence are available in Trust.')
  await act(async () => button('Open Trust').click())
  expect(mocks.setView).toHaveBeenCalledWith('conflicts')
})

it('lists real source precedence and leaves invalid sources unranked', async () => {
  mocks.useStore.mockReturnValue(store({ sources: [source('base', 0), { ...source('broken', 0), quarantined: true, status: 'error' }, source('project', 3)] }))
  await act(async () => root.render(<Overview />))
  const rows = Array.from(container.querySelectorAll('.cc-workspace-sources li'))
  expect(rows[0].textContent).toContain('#1project')
  expect(rows[1].textContent).toContain('#2base')
  expect(rows[2].textContent).toContain('—brokenInvalid configuration')
  await act(async () => button('Manage').click())
  expect(mocks.setView).toHaveBeenCalledWith('sources')
})

it('shows a source setup action for a new workspace and gates agent setup on its real callback', async () => {
  mocks.useStore.mockReturnValue(store({ sources: [] }))
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Start with a source')
  expect(container.textContent).not.toContain('Connect an agent')
  await act(async () => button('Open Sources').click())
  expect(mocks.setView).toHaveBeenCalledWith('sources')
  const connect = vi.fn()
  await act(async () => root.render(<Overview onConnectAgent={connect} />))
  await act(async () => button('Connect an agent').click())
  expect(connect).toHaveBeenCalledOnce()
})
