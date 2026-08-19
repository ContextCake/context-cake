// @vitest-environment jsdom
// The Cascade view's inline resolver: for a broken link — including one that
// reopened as changed_after_decision — it must never offer "use X's answer
// everywhere" (a guaranteed 409), and it offers the engine's suggested fix.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictQuickResolve } from './ConflictQuickResolve'
import type { Conflict } from '../data'

const mocks = vi.hoisted(() => ({ useStore: vi.fn() }))
vi.mock('../store', () => ({ useStoreData: mocks.useStore }))

let container: HTMLDivElement
let root: Root
let anchor: HTMLButtonElement

const reopenedLink: Conflict = {
  id: 'broken_link::notes/a::body::decisions/Old', concept: 'notes/a', sectionKey: 'body', section: 'Body', title: 'Body — Note A',
  status: 'open', winner: 'personal', safe: false, history: [],
  kind: 'changed_after_decision', originalKind: 'broken_link', discrepancyStatus: 'reopened', revision: 'rev-2',
  target: 'decisions/Old', effectiveSource: 'personal',
  contributions: [{ layer: 'personal', sourceLayer: 'personal', value: 'decisions/Old', updated: '2026-05-12' }],
  candidates: [{ id: 'decisions/old', reason: 'case', confidence: 0.95 }],
  bestCandidate: { id: 'decisions/old', reason: 'case', confidence: 0.95 },
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  anchor = document.createElement('button')
  document.body.append(anchor, container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  anchor.remove()
})

describe('ConflictQuickResolve on a broken link', () => {
  it('offers the suggested fix and acknowledge, never "use an answer everywhere", for a reopened broken link', async () => {
    const decideDiscrepancy = vi.fn().mockResolvedValue(undefined)
    mocks.useStore.mockReturnValue({ decideDiscrepancy, resolvingConflict: null, resolutionError: null })
    const onClose = vi.fn()
    await act(async () => root.render(<ConflictQuickResolve conflict={reopenedLink} anchorEl={anchor} onClose={onClose} onOpenFullResolver={vi.fn()} />))

    expect(container.textContent).not.toContain('answer everywhere')
    expect(container.textContent).toContain('Suggested fix')
    expect(container.textContent).toContain('Acknowledge for now')
    const rewrite = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Rewrite to decisions/old')!
    await act(async () => rewrite.click())
    expect(decideDiscrepancy).toHaveBeenCalledWith({ discrepancyId: reopenedLink.id, revision: 'rev-2', action: 'rewrite_link', newTarget: 'decisions/old' })
    expect(onClose).toHaveBeenCalled()
  })

  it('still offers "Open full resolver" without a suggested fix', async () => {
    mocks.useStore.mockReturnValue({ decideDiscrepancy: vi.fn(), resolvingConflict: null, resolutionError: null })
    await act(async () => root.render(<ConflictQuickResolve conflict={{ ...reopenedLink, candidates: [], bestCandidate: null }} anchorEl={anchor} onClose={vi.fn()} onOpenFullResolver={vi.fn()} />))
    expect(container.textContent).not.toContain('Suggested fix')
    expect(container.textContent).toContain('Acknowledge for now')
    expect(container.textContent).toContain('Open full resolver')
  })
})
