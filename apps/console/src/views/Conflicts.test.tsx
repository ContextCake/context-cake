// @vitest-environment jsdom
// The "dissent is newer" badge (contract C-b) renders in the Conflicts view
// only, on the dissenting card whose date beats the effective value. Fixture
// driven — no engine required.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conflicts } from './Conflicts'
import type { Conflict } from '../data'

const mocks = vi.hoisted(() => ({
  useStore: vi.fn(),
}))

vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore }))

let container: HTMLDivElement
let root: Root

function storeWith(conflicts: Conflict[], selConflict: string) {
  return {
    conflicts,
    selConflict,
    setSelConflict: vi.fn(),
    resolveConflict: vi.fn(),
    resolveSafeConflicts: vi.fn(),
    resolvingConflict: null,
    resolutionError: null,
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

describe('Conflicts fresherDissent badge', () => {
  it('badges the flagged dissent card as newer than the effective value', async () => {
    mocks.useStore.mockReturnValue(storeWith([freshConflict, staleConflict], freshConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Newer')
    expect(container.textContent).toContain('Used now')
    expect(container.textContent).toContain('Which answer should ContextCake use?')
  })

  it('shows no freshness badge when no dissent is flagged', async () => {
    mocks.useStore.mockReturnValue(storeWith([staleConflict], staleConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).not.toContain('Newer')
  })

  it('offers one batch wand action for safe conflicts', async () => {
    const store = storeWith([safeConflict], safeConflict.id)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    const wand = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Resolve 1 safe conflict'))
    expect(wand).toBeTruthy()
    await act(async () => wand?.click())
    expect(store.resolveSafeConflicts).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Which answer should ContextCake use?')
  })

  it('does not claim nothing changed when a batch stopped after earlier resolutions', async () => {
    const store = { ...storeWith([safeConflict], safeConflict.id), resolutionError: { message: 'The last source changed.', partial: true } }
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).toContain('Some safe conflicts were resolved.')
    expect(container.textContent).not.toContain('Nothing was changed.')
  })
})
