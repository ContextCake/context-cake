// @vitest-environment jsdom
// Sources management: remove-with-confirm, rename + re-level, sync-now, and
// honest health rows against mocked endpoints (the engine endpoints already
// exist; tests pin the console's side of the contract).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sources } from './Sources'
import type { Source } from '../data'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), useStore: vi.fn(), reload: vi.fn(), openFilesScope: vi.fn() }))

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
let store: { mode: 'live' | 'demo'; sources: Source[]; reloadKey: number }

function mount(sources: Source[], mode: 'live' | 'demo' = 'live', onAddSource?: () => void) {
  store = { mode, sources, reloadKey: 0 }
  mocks.useStore.mockImplementation(() => ({
    mode: store.mode, sources: store.sources, reloadKey: store.reloadKey,
    reload: mocks.reload, openFilesScope: mocks.openFilesScope,
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
  return folder ? `Rename, re-level or repoint ${source.name}` : `Rename or re-level ${source.name}`
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
    expect(container.textContent).toContain('Last success')
    expect(container.textContent).toContain('Last error')
    expect(container.textContent).toContain('github · level 2')
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

describe('Sources rename + re-level', () => {
  it('PATCHes name and level, and leaves an untouched folder out of the body', async () => {
    await mount([src({ name: 'notes', level: 3 })])

    await act(async () => buttonByAria('Rename, re-level or repoint notes').click())

    await enter('#src-edit-name', 'Field notes')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Raise level"]')?.click())
    await act(async () => button('Save').click())

    const call = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(call?.[0]).toBe('/api/sources')
    // No `path`: an unchanged folder must never re-key the index entry and put
    // a settled source through a full re-read for nothing.
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ name: 'notes', newName: 'Field notes', level: 4 })
    expect(mocks.reload).toHaveBeenCalled()
  })

  it('warns before renaming the live layer — staged captures fail closed', async () => {
    await mount([src({ name: 'team', level: 2, layer: 'team', live: true })])

    await act(async () => buttonByAria('Rename, re-level or repoint team').click())
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

    await act(async () => buttonByAria('Rename, re-level or repoint team').click())
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

    await act(async () => buttonByAria('Rename, re-level or repoint notes').click())
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

    await act(async () => buttonByAria('Rename, re-level or repoint notes').click())
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
    await act(async () => buttonByAria('Rename, re-level or repoint notes').click())
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
    await act(async () => buttonByAria('Rename, re-level or repoint notes').click())
    await enter('#src-edit-path', '/Users/me/typo')
    await act(async () => button('Save').click())

    expect(container.textContent).toContain('Folder not found: /Users/me/typo')
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
