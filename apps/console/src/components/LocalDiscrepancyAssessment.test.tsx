// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDiscrepancyAssessment } from './LocalDiscrepancyAssessment'
import type { Conflict } from '../data'
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
let root: Root
let container: HTMLDivElement
const conflict: Conflict = { id: 'd1', concept: 'decisions/db', sectionKey: 'choice', section: 'Choice', title: 'Database', kind: 'section_content', revision: 'rev1', status: 'open', safe: true, winner: 'personal', history: [], contributions: [] }
const assessment = { category: 'scope_difference', selectedSource: 'project', rationale: 'The sources describe different environments.', citations: [{ source: 'project', quote: 'SQLite is only used for local tests.' }], missingEvidence: ['Production decision record'], advisoryOnly: true, automaticallyApplicable: false }
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)! }
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiFetch.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
it('assesses only the user-selected installed model and never applies a policy', async () => {
  mocks.apiFetch.mockImplementation(async (url) => new Response(JSON.stringify(url.endsWith('/models') ? { available: true, models: [{ name: 'local-test', digest: 'sha256:abc', size: 1e9 }] } : { assessment })))
  await act(async () => root.render(<LocalDiscrepancyAssessment conflict={conflict} />))
  expect(mocks.apiFetch).not.toHaveBeenCalled()
  await act(async () => button('Check local models').click())
  expect(button('Assess locally').disabled).toBe(true)
  const select = container.querySelector('select')!
  await act(async () => { select.value = 'sha256:abc'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('Assess locally').click())
  const post = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(post[0]).toBe('/api/discrepancy-assessment')
  expect(JSON.parse(post[1].body)).toEqual({ discrepancyId: 'd1', revision: 'rev1', model: 'local-test', digest: 'sha256:abc' })
  expect(container.textContent).toContain('SQLite is only used for local tests.')
  expect(container.textContent).toContain('Production decision record')
  expect(container.textContent).toContain('No source policy was changed.')
  expect(mocks.apiFetch.mock.calls.some(([url]) => url.includes('context-resolutions'))).toBe(false)
})
it('keeps local runtime unavailability separate from an assessment result', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ available: false, models: [] })))
  await act(async () => root.render(<LocalDiscrepancyAssessment conflict={conflict} />))
  await act(async () => button('Check local models').click())
  expect(container.textContent).toContain('requires the desktop app and a running local model runtime')
  expect(container.querySelector('.cc-local-assessment-result')).toBeNull()
})
