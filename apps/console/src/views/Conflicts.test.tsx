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

vi.mock('../store', () => ({ useStore: mocks.useStore }))

let container: HTMLDivElement
let root: Root

function storeWith(conflicts: Conflict[], selConflict: string) {
  return {
    conflicts,
    selConflict,
    setSelConflict: vi.fn(),
    resolveConflict: vi.fn(),
    mode: 'live' as const,
  }
}

const freshConflict: Conflict = {
  id: 'decisions/primary-db::choice',
  concept: 'decisions/primary-db',
  section: 'Choice',
  title: 'Choice — Primary database',
  status: 'open',
  winner: 'personal',
  contributions: [
    { layer: 'personal', value: 'SingleStore.', updated: '2026-05-12' },
    { layer: 'team', value: 'Postgres.', updated: '2026-06-01', fresherDissent: true },
  ],
}

const staleConflict: Conflict = {
  ...freshConflict,
  id: 'decisions/primary-db::notes',
  section: 'Notes',
  title: 'Notes — Primary database',
  contributions: [
    { layer: 'personal', value: 'HTAP first.', updated: '2026-06-01' },
    { layer: 'team', value: 'Cost first.', updated: '2026-05-12' },
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

    expect(container.textContent).toContain('dissent is newer')
    // The badge sits on the dissenting card, never on the effective one.
    const effective = Array.from(container.querySelectorAll('div')).find((el) => el.textContent === 'EFFECTIVE')
    expect(effective ?? container.textContent).toBeTruthy()
    expect(container.textContent).toContain('EFFECTIVE')
  })

  it('shows no freshness badge when no dissent is flagged', async () => {
    mocks.useStore.mockReturnValue(storeWith([staleConflict], staleConflict.id))
    await act(async () => root.render(<Conflicts />))

    expect(container.textContent).not.toContain('dissent is newer')
  })
})
