// @vitest-environment jsdom
// Sources management: remove-with-confirm, rename + re-level, sync-now, and
// honest health rows against mocked endpoints (the engine endpoints already
// exist; tests pin the console's side of the contract).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sources } from './Sources'
import type { Source } from '../data'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), useStore: vi.fn(), reload: vi.fn() }))

vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../store', () => ({ useStore: mocks.useStore }))

let container: HTMLDivElement
let root: Root

function src(over: Partial<Source>): Source {
  return {
    name: 'notes', kind: 'okf-local', layer: 'personal', coverage: 100,
    focus: '3 concepts · files', status: 'synced', sourceKind: 'files',
    level: 3, conceptCount: 3, origin: null, error: null,
    lastSuccessAt: null, lastErrorAt: null, ...over,
  }
}

function mount(sources: Source[], mode: 'live' | 'demo' = 'live', onAddSource?: () => void) {
  mocks.useStore.mockReturnValue({ mode, sources, reload: mocks.reload })
  return act(async () => root.render(<Sources onAddSource={onAddSource} />))
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

function buttonByAria(label: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!match) throw new Error(`Button not found by aria-label: ${label}`)
  return match
}

async function enter(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)
  await act(async () => {
    if (!input) throw new Error(`Input not found: ${selector}`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function ok(body: Record<string, unknown> = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.apiFetch.mockReset()
  mocks.useStore.mockReset()
  mocks.reload.mockReset()
  mocks.apiFetch.mockImplementation(async () => ok())
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Sources rows', () => {
  it('shows status, health timestamps, and the engine error verbatim', async () => {
    await mount([src({
      name: 'acme-docs', sourceKind: 'github', level: 2, layer: 'team', status: 'degraded',
      error: 'GitHub API 403 on /repos/acme/payments',
      lastSuccessAt: '2026-07-28T09:00:00.000Z', lastErrorAt: '2026-07-28T10:05:00.000Z',
    })])

    expect(container.textContent).toContain('acme-docs')
    expect(container.textContent).toContain('degraded')
    expect(container.textContent).toContain('GitHub API 403 on /repos/acme/payments')
    expect(container.textContent).toContain('last success')
    expect(container.textContent).toContain('last error')
    expect(container.textContent).toContain('level 2 · github')
  })

  it('surfaces missing and host-mismatched credentials without exposing a secret', async () => {
    await mount([
      src({ name: 'missing', authAlias: 'github.com/octocat', authState: 'missing-token' }),
      src({ name: 'mismatch', authAlias: 'github.com/work', authState: 'host-mismatch' }),
      src({ name: 'env', authAlias: 'env:GITHUB_TOKEN', authState: 'missing-token' }),
    ])

    expect(container.textContent).toContain('Credential keychain:github.com/octocat is not connected')
    expect(container.textContent).toContain('bound to a different GitHub host')
    expect(container.textContent).toContain('Environment credential GITHUB_TOKEN is not set')
  })

  it('marks the live team layer and keeps the three-lane model for arbitrary names', async () => {
    await mount([src({ name: 'acme-eng', level: 2, layer: 'team', live: true })])

    expect(container.textContent).toContain('live team layer')
    expect(container.textContent).toContain('Team') // layerOf bucketing survives custom names
  })

  it('renders read-only in demo mode', async () => {
    await mount([src({})], 'demo')

    expect(container.textContent).toContain('source management needs the live engine')
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Rename"]')).toBeNull()
  })
})

describe('Sources remove', () => {
  it('removes only after an explicit confirm, with the name URL-encoded', async () => {
    await mount([src({ name: 'repo docs' })])

    await act(async () => buttonByAria('Remove repo docs').click())
    expect(container.textContent).toContain('Your files stay where they are')
    expect(mocks.apiFetch).not.toHaveBeenCalled()

    await act(async () => button('Remove source').click())
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources?name=repo%20docs', expect.objectContaining({ method: 'DELETE' }))
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('warns that removing the live layer disables team capture for this machine', async () => {
    await mount([src({ name: 'team', level: 2, layer: 'team', live: true })])

    await act(async () => buttonByAria('Remove team').click())
    expect(container.textContent).toContain('disables team capture for this machine')
  })

  it('renders a failed remove verbatim and stays open', async () => {
    mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'No source named "notes"' }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      return ok()
    })
    await mount([src({})])

    await act(async () => buttonByAria('Remove notes').click())
    await act(async () => button('Remove source').click())

    expect(container.textContent).toContain('No source named "notes"')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})

describe('Sources rename + re-level', () => {
  it('PATCHes only name and level — and says a wrong path means remove + re-add', async () => {
    await mount([src({ name: 'notes', level: 3 })])

    await act(async () => buttonByAria('Rename or re-level notes').click())
    expect(container.textContent).toContain('remove this source and add it again')

    await enter('#src-edit-name', 'Field notes')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Raise level"]')?.click())
    await act(async () => button('Save').click())

    const call = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(call?.[0]).toBe('/api/sources')
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ name: 'notes', newName: 'Field notes', level: 4 })
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('warns before renaming the live layer — staged captures fail closed', async () => {
    await mount([src({ name: 'team', level: 2, layer: 'team', live: true })])

    await act(async () => buttonByAria('Rename or re-level team').click())
    expect(container.textContent).toContain('disables team capture for this machine')
    expect(container.textContent).toContain('staged captures fail closed')
  })

  it('renders a pack-invariant 500 readably, verbatim', async () => {
    mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({ error: 'pack invariant violated: layer "team" is assigned to pack data-analytics' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
      return ok()
    })
    await mount([src({ name: 'team', level: 2, layer: 'team' })])

    await act(async () => buttonByAria('Rename or re-level team').click())
    await enter('#src-edit-name', 'platform')
    await act(async () => button('Save').click())

    expect(container.textContent).toContain('pack invariant violated: layer "team" is assigned to pack data-analytics')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})

describe('Sources sync', () => {
  it('offers Sync now for REST github layers and clone-backed layers only', async () => {
    await mount([
      src({ name: 'rest-repo', sourceKind: 'github', level: 2, layer: 'team' }),
      src({ name: 'clone-repo', sourceKind: 'okf-local', origin: 'https://github.com/acme/docs.git', level: 2, layer: 'team' }),
      src({ name: 'plain-folder', sourceKind: 'files' }),
    ])

    expect(container.querySelector('button[aria-label="Sync rest-repo now"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Sync clone-repo now"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Sync plain-folder now"]')).toBeNull()
  })

  it('reports a successful sync with the refreshed concept count', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/sources/sync')) return ok({ ok: true, synced: 'rest-repo', concepts: 12 })
      return ok()
    })
    await mount([src({ name: 'rest-repo', sourceKind: 'github', level: 2, layer: 'team' })])

    await act(async () => buttonByAria('Sync rest-repo now').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources/sync?name=rest-repo', expect.objectContaining({ method: 'POST' }))
    expect(container.textContent).toContain('Synced · 12 concepts')
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('renders a failed sync verbatim', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/sources/sync')) {
        return new Response(JSON.stringify({ error: 'Sync failed: GitHub API 502 on /repos/acme/docs' }), {
          status: 502, headers: { 'content-type': 'application/json' },
        })
      }
      return ok()
    })
    await mount([src({ name: 'rest-repo', sourceKind: 'github', level: 2, layer: 'team' })])

    await act(async () => buttonByAria('Sync rest-repo now').click())

    expect(container.textContent).toContain('Sync failed: GitHub API 502 on /repos/acme/docs')
  })
})
