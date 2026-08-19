// @vitest-environment jsdom
// Sources management: remove-with-confirm, rename + reposition, reorder mode,
// sync-now, and honest health rows against mocked endpoints (the engine
// endpoints already exist; tests pin the console's side of the contract).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sources } from './Sources'
import type { Source } from '../data'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), useStore: vi.fn(), reload: vi.fn(), openFilesScope: vi.fn(), reorderSources: vi.fn() }))

vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore, useStoreChat: mocks.useStore }))

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

/** The store's own state, so a test can move it the way a real reload would. */
let store: { mode: 'live' | 'demo'; sources: Source[]; reloadKey: number; query: string }

function mount(sources: Source[], mode: 'live' | 'demo' = 'live', onAddSource?: () => void) {
  store = { mode, sources, reloadKey: 0, query: '' }
  mocks.useStore.mockImplementation(() => ({
    mode: store.mode, sources: store.sources, reloadKey: store.reloadKey, query: store.query,
    reload: mocks.reload, openFilesScope: mocks.openFilesScope, reorderSources: mocks.reorderSources,
  }))
  return act(async () => root.render(<Sources onAddSource={onAddSource} />))
}

/**
 * What the store does once a write's `reload()` lands: fresh rows from
 * /api/graph and a bumped `reloadKey`. Re-rendering in place rather than
 * remounting is the whole point — a remount refetches the listing by itself and
 * would hide the staleness these tests exist to catch.
 */
function afterWrite(sources: Source[]) {
  store = { ...store, sources, reloadKey: store.reloadKey + 1 }
  return act(async () => root.render(<Sources />))
}

/** A change this app did not make, arriving through the poll: rows move, `reloadKey` does not. */
function afterPoll(sources: Source[]) {
  store = { ...store, sources }
  return act(async () => root.render(<Sources />))
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

/** The edit control names what its panel can change, so its label varies by kind. */
function editLabel(source: Source): string {
  const folder = !source.origin && (source.sourceKind === 'okf-local' || source.sourceKind === 'files')
  return folder ? `Rename, reposition or repoint ${source.name}` : `Rename or reposition ${source.name}`
}

/** Pick a position in the drawer's select (1 = top). */
async function choosePosition(value: number) {
  const select = container.querySelector<HTMLSelectElement>('#src-edit-position')
  await act(async () => {
    if (!select) throw new Error('Position select not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, String(value))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** The rows of the reorder list, as names in the order shown. */
function reorderRows(): string[] {
  return Array.from(container.querySelectorAll('.cc-source-reorder li strong')).map((el) => el.textContent ?? '')
}

function sourceButton(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="option"]'))
    .find((item) => item.querySelector('strong')?.textContent === name)
  if (!match) throw new Error(`Source button not found: ${name}`)
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

/** The metadata `dl`'s value cell for a given label ("Last success", "Last error", …). */
function metadataValue(label: string): string | null {
  const dt = Array.from(container.querySelectorAll('.cc-source-metadata dt')).find((item) => item.textContent === label)
  return dt?.nextElementSibling?.textContent ?? null
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.apiFetch.mockReset()
  mocks.useStore.mockReset()
  mocks.reload.mockReset()
  mocks.openFilesScope.mockReset()
  mocks.reorderSources.mockReset()
  mocks.apiFetch.mockImplementation(async () => ok())
  mocks.reorderSources.mockImplementation(async (order: string[]) => order.map((name, index) => ({ name, level: order.length - index })))
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
    expect(container.textContent).toContain('Last success')
    expect(container.textContent).toContain('Last error')
    // Position, not level: the one source in the cascade is #1 however its
    // manifest happens to number it.
    expect(container.textContent).toContain('github · #1 in cascade')
    expect(container.textContent).not.toContain('level 2')
  })

  it('shows the cascade position everywhere and the raw manifest level in exactly one place', async () => {
    await mount([
      src({ name: 'notes', level: 3, layer: 'personal' }),
      src({ name: 'wiki', level: 2, layer: 'team' }),
      src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
    ])

    // Rows read in cascade order, #1 first.
    const rows = Array.from(container.querySelectorAll('button[role="option"]')).map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('notes')
    expect(rows[0]).toContain('#1 in cascade')
    expect(rows[1]).toContain('wiki')
    expect(rows[1]).toContain('#2 in cascade')
    expect(rows[2]).toContain('graph')
    expect(rows[2]).toContain('#3 in cascade')

    await act(async () => sourceButton('wiki').click())
    const chips = Array.from(container.querySelectorAll('.cc-source-chips > span')).map((chip) => chip.textContent)
    expect(chips).toContain('#2 in cascade')
    expect(chips.some((chip) => /level/.test(chip ?? ''))).toBe(false)
    // The manifest integer survives in one metadata row, for hand-editors.
    expect(metadataValue('Manifest level')).toBe('2 · higher wins')
  })

  it('marks a tie, which the resolver breaks by freshness rather than by order', async () => {
    await mount([src({ name: 'alpha', level: 2, layer: 'personal' }), src({ name: 'beta', level: 2, layer: 'personal' })])
    const rows = Array.from(container.querySelectorAll('button[role="option"]')).map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('alpha')
    expect(rows[0]).toContain('#1 (tied) in cascade')
    expect(rows[1]).toContain('#1 (tied) in cascade')
  })

  it('shows the error string in the Last error field, not just its date', async () => {
    await mount([src({
      name: 'acme-docs', sourceKind: 'github', level: 2, layer: 'team', status: 'degraded',
      error: 'GitHub API 403 on /repos/acme/payments',
      lastSuccessAt: '2026-07-28T09:00:00.000Z', lastErrorAt: '2026-07-28T10:05:00.000Z',
    })])

    expect(metadataValue('Last error')).toContain('GitHub API 403 on /repos/acme/payments')
    expect(metadataValue('Last error')).not.toBe('None')
    // The date is not the fact that matters here, but it's still worth keeping
    // beside the message rather than dropping it.
    expect(metadataValue('Last error')).toContain(new Date('2026-07-28T10:05:00.000Z').toLocaleString())
    expect(metadataValue('Last success')).toBe(new Date('2026-07-28T09:00:00.000Z').toLocaleString())
  })

  it('reports "None" for Last error and "Not yet" for Last success on a source with neither', async () => {
    await mount([src({ name: 'fresh' })])

    expect(metadataValue('Last error')).toBe('None')
    expect(metadataValue('Last success')).toBe('Not yet')
  })

  it('surfaces missing and host-mismatched credentials without exposing a secret', async () => {
    await mount([
      src({ name: 'missing', authAlias: 'github.com/octocat', authState: 'missing-token' }),
      src({ name: 'mismatch', authAlias: 'github.com/work', authState: 'host-mismatch' }),
      src({ name: 'env', authAlias: 'env:GITHUB_TOKEN', authState: 'missing-token' }),
    ])

    await act(async () => sourceButton('missing').click())
    expect(container.textContent).toContain('Credential keychain:github.com/octocat is not connected')
    await act(async () => sourceButton('mismatch').click())
    expect(container.textContent).toContain('bound to a different GitHub host')
    await act(async () => sourceButton('env').click())
    expect(container.textContent).toContain('Environment credential GITHUB_TOKEN is not set')
  })

  it('marks the live team layer and keeps the three-lane model for arbitrary names', async () => {
    await mount([src({ name: 'acme-eng', level: 2, layer: 'team', live: true })])

    expect(container.textContent).toContain('live team layer')
    expect(container.textContent).toContain('Team') // layerOf bucketing survives custom names
  })

  it('renders read-only in demo mode', async () => {
    await mount([src({})], 'demo')

    expect(container.textContent).toContain('Source management needs the live engine')
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Rename"]')).toBeNull()
  })

  // Read-only is about writes, not about looking. The demo bundle carries the
  // files behind `personal`, so the way into the navigator is offered there too.
  it('still offers the way into the files in demo mode', async () => {
    await mount([src({ name: 'personal' })], 'demo')

    expect(container.textContent).toContain('2 files')
    await act(async () => buttonByAria('Browse the files in personal').click())
    expect(mocks.openFilesScope).toHaveBeenCalledWith('personal')
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull()
  })
})

describe('Sources remove', () => {
  it('removes only after an explicit confirm, with the name URL-encoded', async () => {
    await mount([src({ name: 'repo docs' })])

    await act(async () => buttonByAria('Remove repo docs').click())
    expect(container.textContent).toContain('Your files stay where they are')
    expect(mocks.apiFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)

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

describe('Sources with an invalid manifest entry', () => {
  const broken = (over: Partial<Source> = {}) => src({
    name: 'bad-kind', status: 'error', quarantined: true, conceptCount: 0, coverage: 0,
    error: 'Layer bad-kind has unsupported source kind: notarealkind', ...over,
  })

  it('offers only Remove, and says the entry is not a working source', async () => {
    await mount([broken()])

    expect(container.textContent).toContain('This entry is not a working source')
    // Rename writes through the strict manifest path and Sync has nothing to
    // talk to, so offering either would only produce an error.
    expect(container.querySelector('button[aria-label^="Rename"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Sync"]')).toBeNull()
    expect(container.textContent).not.toContain('The path, repository, or command is fixed')
    expect(container.textContent).toContain('unsupported source kind: notarealkind')
    buttonByAria('Remove bad-kind') // throws if absent
  })

  it('removes a lone invalid entry on its own', async () => {
    await mount([src({}), broken()])

    await act(async () => sourceButton('bad-kind').click())
    await act(async () => buttonByAria('Remove bad-kind').click())
    expect(container.textContent).toContain('nothing was being read from this entry')
    await act(async () => button('Remove entry').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources?name=bad-kind', expect.objectContaining({ method: 'DELETE' }))
  })

  it('names every other invalid entry and removes them in one request', async () => {
    // Two invalid entries: the engine only persists a manifest that validates,
    // so removing either alone would be refused. The panel has to say that
    // before the click rather than removing rows the user never selected.
    await mount([src({}), broken(), broken({ name: 'layer 4', error: 'Layer in legacy default must have a non-empty name.' })])

    await act(async () => sourceButton('bad-kind').click())
    await act(async () => buttonByAria('Remove bad-kind').click())
    expect(container.textContent).toContain('One other entry is also invalid')
    expect(container.textContent).toContain('layer 4')

    await act(async () => button('Remove 2 entries').click())
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources?name=bad-kind&name=layer%204', expect.objectContaining({ method: 'DELETE' }))
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('carries the invalid entries along when a healthy source is removed', async () => {
    // The write rewrites the whole manifest, so an invalid entry blocks
    // removing a working source too. Refusing with an explanation the user
    // cannot act on would leave them stuck on a row that has nothing wrong.
    await mount([src({ name: 'notes' }), broken()])

    await act(async () => sourceButton('notes').click())
    await act(async () => buttonByAria('Remove notes').click())
    expect(container.textContent).toContain('One other entry is also invalid')
    expect(container.textContent).toContain('only the cascade entry is removed')

    await act(async () => button('Remove 2 entries').click())
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources?name=notes&name=bad-kind', expect.objectContaining({ method: 'DELETE' }))
  })

  it('leaves an ordinary removal alone when nothing is invalid', async () => {
    await mount([src({ name: 'notes' })])

    await act(async () => buttonByAria('Remove notes').click())
    await act(async () => button('Remove source').click())
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sources?name=notes', expect.objectContaining({ method: 'DELETE' }))
  })

  it('renders the engine refusal verbatim when the manifest cannot be repaired', async () => {
    mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(
          JSON.stringify({ error: 'Nothing was removed: the manifest is invalid in a way this app cannot repair. Edit /kb/manifest.json by hand — legacy default contains duplicate layer name: seed' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return ok()
    })
    await mount([broken()])

    await act(async () => buttonByAria('Remove bad-kind').click())
    await act(async () => button('Remove entry').click())

    expect(container.textContent).toContain('Edit /kb/manifest.json by hand')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})

describe('Sources rename + reposition', () => {
  const cascade = () => [
    src({ name: 'notes', level: 3, layer: 'personal' }),
    src({ name: 'wiki', level: 2, layer: 'team' }),
    src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
  ]

  it('PATCHes a rename alone — no level in the body, no reorder call, no untouched folder', async () => {
    await mount(cascade())

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    // The drawer opens on the source's current position, spelled as a slot
    // among the OTHER sources — never as the manifest integer.
    const select = container.querySelector<HTMLSelectElement>('#src-edit-position')!
    expect(select.value).toBe('1')
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      '1 — top (wins over everything)', '2 — below wiki', '3 — bottom (below graph)',
    ])
    expect(container.querySelector('button[aria-label="Raise level"]')).toBeNull()

    await enter('#src-edit-name', 'Field notes')
    await act(async () => button('Save').click())

    const call = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(call?.[0]).toBe('/api/sources')
    // No `path`: an unchanged folder must never re-key the index entry and put
    // a settled source through a full re-read for nothing. No `level`: the
    // console never sends the integer.
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ name: 'notes', newName: 'Field notes' })
    expect(mocks.reorderSources).not.toHaveBeenCalled()
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('sends a position change as the complete new order (PUT /api/sources/order), and nothing to PATCH', async () => {
    await mount(cascade())

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await choosePosition(3)
    await act(async () => button('Save').click())

    expect(mocks.apiFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false)
    expect(mocks.reorderSources).toHaveBeenCalledWith(['wiki', 'graph', 'notes'])
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('renames first, then reorders under the NEW name, so the second write can find the source', async () => {
    await mount(cascade())

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await enter('#src-edit-name', 'Field notes')
    await choosePosition(2)
    await act(async () => button('Save').click())

    const call = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ name: 'notes', newName: 'Field notes' })
    expect(mocks.reorderSources).toHaveBeenCalledWith(['wiki', 'Field notes', 'graph'])
    expect(container.textContent).not.toContain('position change failed')
  })

  it('says which step failed when the rename landed and the position did not — and the message survives the reload', async () => {
    mocks.reorderSources.mockRejectedValue(new Error('Nothing was reordered: 1 source is invalid and cannot be given a position.'))
    await mount(cascade())

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await enter('#src-edit-name', 'Field notes')
    await choosePosition(3)
    await act(async () => button('Save').click())
    expect(mocks.reload).toHaveBeenCalled()

    // The rename is on disk, so the reload renames the row underneath the
    // drawer. The drawer — and the only copy of the message — must follow the
    // source to its new name rather than close with the old one.
    await afterWrite([
      src({ name: 'Field notes', level: 3, layer: 'personal' }),
      src({ name: 'wiki', level: 2, layer: 'team' }),
      src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
    ])
    expect(container.textContent).toContain('Renamed, but the position change failed — Nothing was reordered: 1 source is invalid')
    expect(container.querySelector('button[role="option"][aria-selected="true"] strong')?.textContent).toBe('Field notes')
    // The chosen position is kept, so Save can retry the half that failed.
    expect(container.querySelector<HTMLSelectElement>('#src-edit-position')!.value).toBe('3')
  })

  it('clamps a chosen position the shrunken cascade can no longer offer, and saves what the select showed', async () => {
    await mount(cascade())
    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await choosePosition(3)
    // A source disappears under the open drawer (removed elsewhere, seen via
    // the poll): the select can only offer 1..2 now, shows 2 — and 2 is what
    // must be saved, not the 3 no option ever showed.
    await afterPoll([src({ name: 'notes', level: 3, layer: 'personal' }), src({ name: 'wiki', level: 2, layer: 'team' })])
    const select = container.querySelector<HTMLSelectElement>('#src-edit-position')!
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['1 — top (wins over everything)', '2 — bottom (below wiki)'])
    expect(select.value).toBe('2')

    await act(async () => button('Save').click())
    expect(mocks.reorderSources).toHaveBeenCalledWith(['wiki', 'notes'])
    expect(container.textContent).toContain('Moved to position 2 of 2.')
  })

  it('leaves the cascade alone when saving without any change', async () => {
    await mount(cascade())
    await act(async () => sourceButton('wiki').click())
    await act(async () => buttonByAria('Rename, reposition or repoint wiki').click())
    expect(container.querySelector<HTMLSelectElement>('#src-edit-position')!.value).toBe('2')
    await act(async () => button('Save').click())
    expect(mocks.apiFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false)
    expect(mocks.reorderSources).not.toHaveBeenCalled()
  })

  it('warns before renaming the live layer — staged captures fail closed', async () => {
    await mount([src({ name: 'team', level: 2, layer: 'team', live: true })])

    await act(async () => buttonByAria('Rename, reposition or repoint team').click())
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

    await act(async () => buttonByAria('Rename, reposition or repoint team').click())
    await enter('#src-edit-name', 'platform')
    await act(async () => button('Save').click())

    expect(container.textContent).toContain('pack invariant violated: layer "team" is assigned to pack data-analytics')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})

describe('Sources → Files', () => {
  const listing = (layers: unknown[]) => ok({ layers })

  it('shows the file count and root path, and browses scoped to that source', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') {
        return listing([{ layer: 'notes', kind: 'files', root: '/Users/me/vault', fileCount: 3014, truncated: false, files: [] }])
      }
      return ok()
    })
    await mount([src({ name: 'notes' })])

    expect(container.textContent).toContain('3014 files')
    expect(container.textContent).toContain('/Users/me/vault')

    await act(async () => buttonByAria('Browse the files in notes').click())
    expect(mocks.openFilesScope).toHaveBeenCalledWith('notes')
  })

  it('says a remote source keeps nothing locally, and offers no browse action', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => (url === '/api/files' ? listing([]) : ok()))
    await mount([src({ name: 'company-graph', kind: 'mcp', sourceKind: 'mcp', level: 0, layer: 'company', status: 'serving' })])

    expect(container.textContent).toContain('None on this machine — remote graph')
    expect(container.querySelector('button[aria-label^="Browse"]')).toBeNull()
  })

  it('marks a truncated listing rather than quoting a count it knows is short', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') {
        return listing([{ layer: 'notes', kind: 'files', root: '/vault', fileCount: 10000, truncated: true, files: [] }])
      }
      return ok()
    })
    await mount([src({ name: 'notes' })])

    expect(container.textContent).toContain('10000+ files')
  })

  it('hides Reveal in Finder outside the desktop app and reveals the layer root inside it', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => (url === '/api/files'
      ? listing([{ layer: 'notes', kind: 'files', root: '/Users/me/vault', fileCount: 3, truncated: false, files: [] }])
      : ok()))
    await mount([src({ name: 'notes' })])
    expect(container.querySelector('button[aria-label^="Reveal"]')).toBeNull()

    const revealFile = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP = { revealFile }
    await mount([src({ name: 'notes' })])
    await act(async () => buttonByAria('Reveal the folder for notes in Finder').click())
    // The source's own name and an empty relative path — the main process
    // resolves the root; the renderer never names an absolute path.
    expect(revealFile).toHaveBeenCalledWith('notes', '')
    delete (window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP
  })
})

describe('Sources: the file listing follows the source', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    layer: 'notes', kind: 'files', root: '/Users/me/vault', fileCount: 3014, truncated: false, files: [], ...over,
  })

  /** `/api/files` answers from `listed`, which a test moves the way the engine would. */
  function serve(listed: () => unknown[]) {
    mocks.apiFetch.mockImplementation(async (url: string) => (url === '/api/files' ? ok({ layers: listed() }) : ok()))
  }

  it('refetches after a rename, instead of losing the files under the old name', async () => {
    let listed = [entry()]
    serve(() => listed)
    await mount([src({ name: 'notes' })])
    expect(container.textContent).toContain('3014 files')

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await enter('#src-edit-name', 'notes-2')
    await act(async () => button('Save').click())
    // The engine keys the listing by layer name, so the same folder comes back
    // under the new one.
    listed = [entry({ layer: 'notes-2' })]
    await afterWrite([src({ name: 'notes-2' })])

    // Keyed on the source count, none of this moved: the map was still keyed by
    // `notes`, so a source with 3,014 files read "None on this machine" and its
    // way into the navigator disappeared.
    expect(container.textContent).toContain('3014 files')
    expect(container.textContent).toContain('/Users/me/vault')
    expect(container.textContent).not.toContain('None on this machine')
    expect(container.querySelector('button[aria-label="Browse the files in notes-2"]')).toBeTruthy()
  })

  it('refetches after a repoint, instead of quoting the folder it no longer reads', async () => {
    let listed = [entry({ fileCount: 3 })]
    serve(() => listed)
    await mount([src({ name: 'notes' })])
    expect(container.textContent).toContain('/Users/me/vault')

    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await enter('#src-edit-path', '/Volumes/Work/notes')
    await act(async () => button('Save').click())
    listed = [entry({ root: '/Volumes/Work/notes', fileCount: 7 })]
    // Nothing in `sources` changed here — same name, same level, same count.
    // The move is only visible in the listing, which is why `reloadKey` and not
    // the rows is what has to drive the refetch.
    await afterWrite([src({ name: 'notes' })])

    expect(container.textContent).toContain('/Volumes/Work/notes')
    expect(container.textContent).toContain('7 files')
    expect(container.textContent).not.toContain('/Users/me/vault')

    // And the editor prefills from the listing, so reopening it offers the new
    // folder rather than the one the save just moved away from.
    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    expect(container.querySelector<HTMLInputElement>('#src-edit-path')!.value).toBe('/Volumes/Work/notes')
  })

  it('refetches for a source added outside this app, which never calls reload()', async () => {
    let listed = [entry({ fileCount: 3 })]
    serve(() => listed)
    await mount([src({ name: 'notes' })])

    listed = [entry({ fileCount: 3 }), entry({ layer: 'scratch', root: '/Users/me/scratch', fileCount: 9 })]
    await afterPoll([src({ name: 'notes' }), src({ name: 'scratch', level: 2, layer: 'team' })])

    await act(async () => sourceButton('scratch').click())
    expect(container.textContent).toContain('9 files')
    expect(container.textContent).toContain('/Users/me/scratch')
  })
})

describe('Sources: repointing a folder', () => {
  const listing = (root: string) => ok({
    layers: [{ layer: 'notes', kind: 'files', root, fileCount: 3, truncated: false, files: [] }],
  })

  async function openEditor(source: Source, root = '/Users/me/vault') {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/files') return listing(root)
      if (init?.method === 'PATCH') return ok({ ok: true, reindexing: true, hasDocuments: true })
      return ok()
    })
    await mount([source])
    await act(async () => buttonByAria(editLabel(source)).click())
  }

  it('offers a labelled folder field prefilled with the source root, and PATCHes the move', async () => {
    await openEditor(src({ name: 'notes', level: 3 }))

    const field = container.querySelector<HTMLInputElement>('#src-edit-path')!
    expect(field.value).toBe('/Users/me/vault')
    // A form control with no accessible name is the Critical failure this
    // panel must not reintroduce.
    expect(container.querySelector('label[for="src-edit-path"]')?.textContent).toBe('Folder')
    expect(container.textContent).not.toContain('remove this source and add it again')

    await enter('#src-edit-path', '/Users/me/vault-2')
    await act(async () => button('Save').click())

    const call = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ name: 'notes', path: '/Users/me/vault-2' })
    // The row is about to say "indexing"; naming the cause first is the
    // difference between progress and a source that looks broken.
    expect(container.textContent).toContain('reading it now')
  })

  it('fills the folder field from the native picker', async () => {
    const chooseFolder = vi.fn().mockResolvedValue('/Volumes/Work/notes')
    ;(window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP = { chooseFolder }
    await openEditor(src({ name: 'notes' }))

    await act(async () => button('Choose…').click())
    expect(container.querySelector<HTMLInputElement>('#src-edit-path')!.value).toBe('/Volumes/Work/notes')
    delete (window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP
  })

  it('offers no folder field for a repo read over the API, and keeps the honest advice', async () => {
    await openEditor(src({ name: 'notes', sourceKind: 'github', kind: 'okf-local' }))
    expect(container.querySelector('#src-edit-path')).toBeNull()
    expect(container.textContent).toContain('read from its repository over the GitHub API')
  })

  it('offers no folder field for a clone, whose folder belongs to Sync', async () => {
    await openEditor(src({ name: 'notes', sourceKind: 'okf-local', origin: 'https://github.com/o/r.git' }))
    expect(container.querySelector('#src-edit-path')).toBeNull()
    expect(container.textContent).toContain('its folder is managed by Sync')
  })

  it('renders the engine refusal verbatim rather than paraphrasing it', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/files') return listing('/Users/me/vault')
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({ error: 'Folder not found: /Users/me/typo' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return ok()
    })
    await mount([src({ name: 'notes' })])
    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    await enter('#src-edit-path', '/Users/me/typo')
    await act(async () => button('Save').click())

    expect(container.textContent).toContain('Folder not found: /Users/me/typo')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})

describe('Sources reorder mode', () => {
  const cascade = () => [
    src({ name: 'notes', level: 3, layer: 'personal' }),
    src({ name: 'wiki', level: 2, layer: 'team' }),
    src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
  ]

  /** A drag event jsdom does not model — DataTransfer is faked, the coordinates are what the test says. */
  function dragEvent(type: 'dragstart' | 'dragover' | 'drop' | 'dragend', payload: string, clientY = 0) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown; clientY?: number }
    const store: Record<string, string> = payload ? { 'text/plain': payload } : {}
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        setData: (kind: string, value: string) => { store[kind] = value },
        getData: (kind: string) => store[kind] ?? '',
        effectAllowed: 'uninitialized', dropEffect: 'none', types: Object.keys(store),
      },
    })
    Object.defineProperty(event, 'clientY', { value: clientY })
    return event
  }

  const row = (name: string) => reorderRows().indexOf(name) >= 0
    ? container.querySelectorAll<HTMLLIElement>('.cc-source-reorder li')[reorderRows().indexOf(name)]
    : (() => { throw new Error(`Reorder row not found: ${name}`) })()

  it('lists every source in cascade order with a grip and Move up / Move down for each', async () => {
    await mount(cascade())
    expect(container.querySelector('.cc-source-reorder')).toBeNull()

    await act(async () => button('Reorder').click())
    expect(reorderRows()).toEqual(['notes', 'wiki', 'graph'])
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Done')
    // The listbox is replaced by the reorder list: one interaction surface at a time.
    expect(container.querySelector('button[role="option"]')).toBeNull()
    // Ends are disabled — a keyboard user is told the move is impossible, not
    // handed a button that silently does nothing.
    expect(buttonByAria('Move notes up').disabled).toBe(true)
    expect(buttonByAria('Move notes down').disabled).toBe(false)
    expect(buttonByAria('Move graph down').disabled).toBe(true)
    expect(container.querySelectorAll('.cc-source-grip')).toHaveLength(3)

    await act(async () => button('Done').click())
    expect(container.querySelector('.cc-source-reorder')).toBeNull()
    expect(container.querySelectorAll('button[role="option"]')).toHaveLength(3)
  })

  it('Move down commits the whole new order at once and announces where the row landed', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())

    await act(async () => buttonByAria('Move notes down').click())

    expect(mocks.reorderSources).toHaveBeenCalledTimes(1)
    expect(mocks.reorderSources).toHaveBeenCalledWith(['wiki', 'notes', 'graph'])
    expect(mocks.reload).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Moved notes to position 2 of 3')
  })

  it('Move up sends the order with the row one slot earlier', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())

    await act(async () => buttonByAria('Move graph up').click())

    expect(mocks.reorderSources).toHaveBeenCalledWith(['notes', 'graph', 'wiki'])
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Moved graph to position 2 of 3')
  })

  it('draws from the store, never a local copy: the list follows the reload, and controls wait for it', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())
    await act(async () => buttonByAria('Move notes down').click())

    // Until the store catches up the rows still show the pre-move order — the
    // list is never drawn from a pending local copy — and every control is
    // held (aria-disabled + click guard, not `disabled`, which would drop
    // keyboard focus) so a second press cannot be computed from a stale order.
    expect(reorderRows()).toEqual(['notes', 'wiki', 'graph'])
    expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBe('true')
    expect(buttonByAria('Move graph up').getAttribute('aria-disabled')).toBe('true')
    expect(container.querySelector('.cc-source-reorder li')?.getAttribute('draggable')).toBe('false')
    await act(async () => buttonByAria('Move notes down').click())
    await act(async () => buttonByAria('Move graph up').click())
    expect(mocks.reorderSources).toHaveBeenCalledTimes(1)

    await afterWrite([
      src({ name: 'wiki', level: 3, layer: 'personal' }),
      src({ name: 'notes', level: 2, layer: 'team' }),
      src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
    ])
    expect(reorderRows()).toEqual(['wiki', 'notes', 'graph'])
    expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBeNull()
    expect(buttonByAria('Move notes down').disabled).toBe(false)
    expect(buttonByAria('Move wiki up').disabled).toBe(true)
    expect(container.querySelector('.cc-source-reorder li')?.getAttribute('draggable')).toBe('true')
  })

  it('asks for a refresh again while the list stays stale, then hands the controls back with a warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await mount(cascade())
      await act(async () => button('Reorder').click())
      await act(async () => buttonByAria('Move notes down').click())
      expect(mocks.reload).toHaveBeenCalledTimes(1)
      expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBe('true')

      // The store never catches up (the reload keeps failing). Every 6s another
      // refresh is asked for and the row says so — five times, bounded.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await act(async () => { vi.advanceTimersByTime(6_000) })
        expect(mocks.reload).toHaveBeenCalledTimes(1 + attempt)
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(`retrying (${attempt} of 5)`)
        expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBe('true')
      }

      // After the last attempt: unlocked, and honest that the list may be stale.
      await act(async () => { vi.advanceTimersByTime(6_000) })
      expect(mocks.reload).toHaveBeenCalledTimes(6)
      expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBeNull()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Leave and re-enter Reorder to continue')
      expect(container.querySelector('.cc-source-reorder li')?.getAttribute('draggable')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the retry notice once the store catches up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await mount(cascade())
      await act(async () => button('Reorder').click())
      await act(async () => buttonByAria('Move notes down').click())
      await act(async () => { vi.advanceTimersByTime(6_000) })
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('retrying (1 of 5)')

      await afterWrite([
        src({ name: 'wiki', level: 3, layer: 'personal' }),
        src({ name: 'notes', level: 2, layer: 'team' }),
        src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
      ])
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(buttonByAria('Move notes down').getAttribute('aria-disabled')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps keyboard focus on the moved row — on the pressed arrow, or its twin when the row reached an end', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())

    // A middle move: the pressed arrow keeps focus across the save.
    const down = buttonByAria('Move notes down')
    down.focus()
    await act(async () => down.click())
    await afterWrite([
      src({ name: 'wiki', level: 3, layer: 'personal' }),
      src({ name: 'notes', level: 2, layer: 'team' }),
      src({ name: 'graph', level: 0, layer: 'company', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
    ])
    expect(document.activeElement).toBe(buttonByAria('Move notes down'))

    // An end move: "down" is now disabled for the bottom row, so focus lands
    // on the row's "up" arrow instead of falling to the document.
    await act(async () => buttonByAria('Move notes down').click())
    await afterWrite([
      src({ name: 'wiki', level: 3, layer: 'personal' }),
      src({ name: 'graph', level: 2, layer: 'team', sourceKind: 'mcp', kind: 'mcp', status: 'serving' }),
      src({ name: 'notes', level: 0, layer: 'company' }),
    ])
    expect(buttonByAria('Move notes down').disabled).toBe(true)
    expect(document.activeElement).toBe(buttonByAria('Move notes up'))
  })

  it('lists a quarantined entry last, without a position, and keeps the cascade ranks for the rest', async () => {
    await mount([
      src({ name: 'notes', level: 3, layer: 'personal' }),
      src({ name: 'base', level: 0, layer: 'company' }),
      src({ name: 'bad-kind', level: 0, status: 'error', quarantined: true, conceptCount: 0, coverage: 0, error: 'unsupported source kind' }),
    ])
    const rows = Array.from(container.querySelectorAll('button[role="option"]')).map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('notes')
    expect(rows[0]).toContain('#1 in cascade')
    expect(rows[1]).toContain('base')
    // Not "#2 (tied)": the invalid entry is not in the cascade at all.
    expect(rows[1]).toContain('#2 in cascade')
    expect(rows[2]).toContain('bad-kind')
    expect(rows[2]).toContain('no position — invalid entry')
    expect(rows[2]).not.toContain('#')
  })

  it('a drop commits the order too — before or after the row it lands on', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())

    // Drag graph onto notes. With jsdom's zero-height rows the pointer is
    // never above the midpoint, so this lands AFTER notes.
    await act(async () => { row('graph').dispatchEvent(dragEvent('dragstart', 'graph')) })
    await act(async () => { row('notes').dispatchEvent(dragEvent('dragover', 'graph', 0)) })
    expect(row('notes').getAttribute('data-drop')).toBe('after')
    await act(async () => { row('notes').dispatchEvent(dragEvent('drop', 'graph', 0)) })

    expect(mocks.reorderSources).toHaveBeenCalledWith(['notes', 'graph', 'wiki'])
    expect(container.querySelector('[data-drop]')).toBeNull()
  })

  it('a drop with a negative pointer offset lands before the row', async () => {
    await mount(cascade())
    await act(async () => button('Reorder').click())

    await act(async () => { row('graph').dispatchEvent(dragEvent('dragstart', 'graph')) })
    await act(async () => { row('notes').dispatchEvent(dragEvent('dragover', 'graph', -5)) })
    expect(row('notes').getAttribute('data-drop')).toBe('before')
    await act(async () => { row('notes').dispatchEvent(dragEvent('drop', 'graph', -5)) })

    expect(mocks.reorderSources).toHaveBeenCalledWith(['graph', 'notes', 'wiki'])
  })

  it('renders a refused reorder verbatim and leaves the list where the engine says it is', async () => {
    mocks.reorderSources.mockRejectedValue(new Error('Nothing was reordered: the manifest is invalid in a way this operation cannot work around.'))
    await mount(cascade())
    await act(async () => button('Reorder').click())

    await act(async () => buttonByAria('Move notes down').click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Nothing was reordered')
    expect(mocks.reload).not.toHaveBeenCalled()
    expect(reorderRows()).toEqual(['notes', 'wiki', 'graph'])
    // A failed move holds nothing back: the controls are live again.
    expect(buttonByAria('Move notes down').disabled).toBe(false)
  })

  it('is disabled, with the reason, while any manifest entry is quarantined', async () => {
    await mount([src({ name: 'notes' }), src({ name: 'bad-kind', status: 'error', quarantined: true, conceptCount: 0, coverage: 0, error: 'unsupported source kind' })])

    const toggle = button('Reorder')
    expect(toggle.disabled).toBe(true)
    expect(toggle.title).toContain('Remove the invalid entry first')
    expect(toggle.title).toContain('bad-kind')
  })

  it('holds the drawer position select too while an entry is quarantined — the engine would refuse it', async () => {
    await mount([src({ name: 'notes' }), src({ name: 'bad-kind', status: 'error', quarantined: true, conceptCount: 0, coverage: 0, error: 'unsupported source kind' })])
    await act(async () => sourceButton('notes').click())
    await act(async () => buttonByAria('Rename, reposition or repoint notes').click())
    expect(container.querySelector<HTMLSelectElement>('#src-edit-position')!.disabled).toBe(true)
    expect(container.textContent).toContain('Reordering is off until the invalid entry is removed')
  })

  it('is disabled with one source and absent in demo mode', async () => {
    await mount([src({ name: 'notes' })])
    expect(button('Reorder').disabled).toBe(true)
    expect(button('Reorder').title).toContain('nothing to reorder')

    await mount([src({ name: 'notes' }), src({ name: 'wiki', level: 2, layer: 'team' })], 'demo')
    expect(Array.from(container.querySelectorAll('button')).some((item) => item.textContent === 'Reorder')).toBe(false)
  })

  it('ignores the search filter while reordering, and says so', async () => {
    await mount(cascade())
    store = { ...store, query: 'wiki' }
    await act(async () => root.render(<Sources />))
    expect(container.querySelectorAll('button[role="option"]')).toHaveLength(1)

    await act(async () => button('Reorder').click())
    expect(reorderRows()).toEqual(['notes', 'wiki', 'graph'])
    expect(container.textContent).toContain('Showing all 3 sources while reordering')
  })
})

describe('Sources sync', () => {
  it('offers Sync now for REST github layers and clone-backed layers only', async () => {
    await mount([
      src({ name: 'rest-repo', sourceKind: 'github', level: 2, layer: 'team' }),
      src({ name: 'clone-repo', sourceKind: 'okf-local', origin: 'https://github.com/acme/docs.git', level: 2, layer: 'team' }),
      src({ name: 'plain-folder', sourceKind: 'files' }),
    ])

    await act(async () => sourceButton('rest-repo').click())
    expect(container.querySelector('button[aria-label="Sync rest-repo now"]')).toBeTruthy()
    await act(async () => sourceButton('clone-repo').click())
    expect(container.querySelector('button[aria-label="Sync clone-repo now"]')).toBeTruthy()
    await act(async () => sourceButton('plain-folder').click())
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
