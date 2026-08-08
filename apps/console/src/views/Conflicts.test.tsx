// @vitest-environment jsdom
// Professional discrepancy presentation and governed decision affordances.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conflicts } from './Conflicts'
import type { Conflict } from '../data'

const mocks = vi.hoisted(() => ({
  useStore: vi.fn(),
}))

vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore, useStoreChat: mocks.useStore }))

let container: HTMLDivElement
let root: Root

function storeWith(conflicts: Conflict[], selConflict: string) {
  return {
    mode: 'demo', query: '',
    conflicts,
    selConflict,
    setSelConflict: vi.fn(),
    resolveConflict: vi.fn(),
    resolveSafeConflicts: vi.fn(),
    resolvingConflict: null,
    resolutionError: null,
    discrepancyRules: [], discrepancyRuleSuggestions: [],
    decideDiscrepancy: vi.fn(), setDiscrepancyPriority: vi.fn(),
    approveRuleSuggestion: vi.fn(), updateDiscrepancyRule: vi.fn(), promoteDiscrepancyRule: vi.fn(),
    openFilesScope: vi.fn(),
  }
}

const freshConflict: Conflict = {
  id: 'decisions/primary-db::choice',
  concept: 'decisions/primary-db',
  sectionKey: 'choice',
  section: 'Choice',
  title: 'Choice — Primary database',
  status: 'open',
  winner: 'personal',
  safe: false,
  history: [],
  kind: 'section_content', discrepancyStatus: 'needs_review', revision: 'rev-1',
  effectiveSource: 'personal', winnerReason: 'personal wins by configured layer precedence.',
  owner: 'Platform', priority: 'unassigned', coverageComplete: true,
  sourceHealth: [{ source: 'personal', status: 'ok', error: null }, { source: 'team', status: 'ok', error: null }],
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'SingleStore.', updated: '2026-05-12' },
    { layer: 'team', sourceLayer: 'team', value: 'Postgres.', updated: '2026-06-01', fresherDissent: true },
  ],
}

const staleConflict: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::notes',
  sectionKey: 'notes',
  section: 'Notes',
  title: 'Notes — Primary database',
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'HTAP first.', updated: '2026-06-01' },
    { layer: 'team', sourceLayer: 'team', value: 'Cost first.', updated: '2026-05-12' },
  ],
}

const safeConflict: Conflict = {
  ...staleConflict,
  id: 'interfaces/auth-tokens::header',
  concept: 'interfaces/auth-tokens',
  sectionKey: 'header',
  section: 'Header',
  title: 'Header — Auth tokens',
  safe: true,
  contributions: [
    { layer: 'team', sourceLayer: 'team', value: 'Send the token as bearer.', updated: '2026-06-01' },
    { layer: 'company', sourceLayer: 'company', value: 'Send the token as **Bearer**', updated: '2026-05-12' },
  ],
}

const codeConflict: Conflict = {
  ...freshConflict,
  id: 'interfaces/client::example',
  concept: 'interfaces/client',
  sectionKey: 'example',
  section: 'Example',
  contributions: [
    { layer: 'personal', sourceLayer: 'personal', value: 'const port = 3000;\nstart(port);', updated: '2026-05-12' },
    { layer: 'team', sourceLayer: 'team', value: 'const port = 8080;\nstart(port);', updated: '2026-06-01' },
  ],
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Discrepancy Center', () => {
  it('badges the flagged dissent card as newer than the effective value', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Newer dissent')
    expect(container.textContent).toContain('Effective now')
    expect(container.textContent).toContain('Choose a safe disposition')
  })

  it('shows no freshness badge when no dissent is flagged', async () => {
    mocks.useStore.mockReturnValue(storeWith([staleConflict], staleConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(Array.from(container.querySelectorAll('.cc-discrepancy-answer')).some((answer) => answer.textContent?.includes('Newer dissent'))).toBe(false)
  })

  it('shows both removed and added prose instead of hiding reordered or deleted words', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.querySelector('.cc-word-diff del')?.textContent).toContain('SingleStore')
    expect(container.querySelector('.cc-word-diff mark')?.textContent).toContain('Postgres')
  })

  it('shows removed and added lines for structured content', async () => {
    mocks.useStore.mockReturnValue(storeWith([codeConflict], codeConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.querySelector('.cc-line-diff [data-change="removed"]')?.textContent).toContain('3000')
    expect(container.querySelector('.cc-line-diff [data-change="added"]')?.textContent).toContain('8080')
  })

  it('labels every demo action as a simulation and never offers automatic execution', async () => {
    const store = storeWith([safeConflict], safeConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Simulate using')
    expect(container.textContent).toContain('Simulation history resets on reload.')
  })

  it('requires a reason before an acknowledgement can be submitted', async () => {
    const store = storeWith([safeConflict], safeConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))
    const radio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.parentElement?.textContent?.includes('Keep the scoped difference'))!
    await act(async () => radio.click())
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Simulate acknowledgement'))!
    expect(submit.disabled).toBe(true)
    const reason = container.querySelector<HTMLSelectElement>('[aria-label="Acknowledgement reason"]')!
    await act(async () => { reason.value = 'different_scopes'; reason.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(submit.disabled).toBe(false)
  })
})
