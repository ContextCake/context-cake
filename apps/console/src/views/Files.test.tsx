// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Files } from './Files'
// The real generated demo bundle — the same JSON the shipped web build imports.
// The demo tests below run against it rather than a fixture, because what they
// are checking is precisely that the build-time snapshot feeds this view.
import demoBundle from '../generated/demo-cascade.json'
import demoFiles from '../generated/demo-files.json'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  reload: vi.fn(),
  openConcept: vi.fn(),
  store: {
    mode: 'live',
    sources: [] as unknown[],
    concepts: [] as unknown[],
    query: '',
    scope: null as string | null,
    path: null as string | null,
    reloadKey: 0,
  },
}))

vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
// Scope and selection live in the store now (they are the URL), so the mock has
// to be a real state holder — a frozen object would make every selection a no-op
// and quietly pass tests that assert nothing moved.
vi.mock('../store', async () => {
  const { useState } = await import('react')
  // The scope/path setters live in the data context and the values live in the
  // nav context, so the mock has to bridge them: the nav hook owns the useState
  // pair and publishes its setters here for the data hook's stable wrappers.
  const bridge: {
    scope?: (value: string | null) => void
    path?: (value: string | null) => void
  } = {}
  const setFilesScope = (value: string | null) => bridge.scope?.(value)
  const setFilesPath = (value: string | null) => bridge.path?.(value)
  const useStoreData = () => ({
    mode: mocks.store.mode,
    sources: mocks.store.sources,
    concepts: mocks.store.concepts,
    reload: mocks.reload,
    reloadKey: mocks.store.reloadKey,
    setFilesScope,
    setFilesPath,
    openConcept: mocks.openConcept,
  })
  const useStoreNav = () => {
    const [filesScope, setScope] = useState<string | null>(mocks.store.scope)
    const [filesPath, setPath] = useState<string | null>(mocks.store.path)
    bridge.scope = setScope
    bridge.path = setPath
    return { filesScope, filesPath }
  }
  const useStoreInput = () => ({ query: mocks.store.query })
  const useStoreChat = () => ({ chatBusy: false, chatInput: '', chatMessages: [] })
  return {
    useStoreData,
    useStoreNav,
    useStoreInput,
    useStoreChat,
    useStore: () => ({ ...useStoreData(), ...useStoreNav(), ...useStoreInput(), ...useStoreChat() }),
  }
})

let container: HTMLDivElement
let root: Root

const FILES = {
  layers: [
    {
      layer: 'personal',
      kind: 'files',
      root: '/home/me/notes',
      fileCount: 2,
      truncated: false,
      files: [
        { path: 'personal/meeting.md', name: 'meeting.md', rel: 'meeting.md', ext: '.md', kind: 'text', markdown: true },
        { path: 'personal/logo.png', name: 'logo.png', rel: 'logo.png', ext: '.png', kind: 'image', markdown: false },
      ],
    },
  ],
}

/** One tree row, by the engine path it carries in `title`. */
function row(path: string): HTMLElement {
  const match = container.querySelector<HTMLElement>(`[role="treeitem"][title="${path}"]`)
  if (!match) throw new Error(`Tree row not found: ${path}`)
  return match
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'))
}

const MEETING = {
  path: 'personal/meeting.md',
  layer: 'personal',
  rel: 'meeting.md',
  ext: '.md',
  kind: 'text',
  editable: true,
  markdown: true,
  bytes: 42,
  modified: '2026-07-01T10:00:00.000Z',
  text: '# Meeting\n\n## Decision\n\nShip on **Friday**.\n',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.apiFetch.mockReset()
  mocks.reload.mockReset()
  mocks.openConcept.mockReset()
  mocks.store.mode = 'live'
  mocks.store.sources = []
  mocks.store.concepts = []
  mocks.store.query = ''
  mocks.store.scope = null
  mocks.store.path = null
  mocks.store.reloadKey = 0
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/files') return json(FILES)
    if (url.startsWith('/api/file/raw?')) return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })
    if (url.startsWith('/api/file?')) return json(MEETING)
    return json({})
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Files view', () => {
  it('lists each layer with its files and opens a markdown file rendered', async () => {
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('personal')
    expect(container.textContent).toContain('meeting.md')
    // Rendered by default: the bold survives as markup, not as asterisks.
    expect(container.querySelector('.cc-md')?.innerHTML).toContain('<strong>Friday</strong>')
    expect(container.textContent).not.toContain('**Friday**')
  })

  it('switches to the raw Markdown source on demand', async () => {
    await act(async () => root.render(<Files />))
    await act(async () => button('raw').click())

    const editor = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(editor?.value).toBe(MEETING.text)
    expect(container.querySelector('.cc-md')).toBeNull()
  })

  it('saves an edit and asks the cascade to re-resolve', async () => {
    await act(async () => root.render(<Files />))
    await act(async () => button('raw').click())

    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, '# Meeting\n\n## Decision\n\nShip on Monday.\n')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('unsaved changes')

    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/file' && init?.method === 'PUT') return json({ ok: true, modified: '2026-07-02T10:00:00.000Z' })
      if (url === '/api/files') return json(FILES)
      return json(MEETING)
    })
    await act(async () => button('Save').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/file', expect.objectContaining({ method: 'PUT' }))
    const saveCall = mocks.apiFetch.mock.calls.find(([url, init]) => url === '/api/file' && init?.method === 'PUT')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({ modified: MEETING.modified })
    // An edit changes the resolved cascade — every other view has to re-read it.
    expect(mocks.reload).toHaveBeenCalled()
    expect(container.textContent).not.toContain('unsaved changes')
  })

  it('surfaces a save failure instead of pretending the edit landed', async () => {
    await act(async () => root.render(<Files />))
    await act(async () => button('raw').click())

    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'changed')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/file' && init?.method === 'PUT') return json({ error: 'Path escapes its layer root' }, 403)
      return json(MEETING)
    })
    await act(async () => button('Save').click())

    expect(container.textContent).toContain('Path escapes its layer root')
    expect(container.textContent).toContain('unsaved changes')
  })

  it('loads a non-text preview through the authenticated API', async () => {
    let releasePreview: (response: Response) => void = () => {}
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(FILES)
      if (url.startsWith('/api/file/raw?')) {
        return new Promise<Response>((resolve) => { releasePreview = resolve })
      }
      return json({
        path: 'personal/logo.png', layer: 'personal', rel: 'logo.png', ext: '.png',
        kind: 'image', editable: false, markdown: false, bytes: 900, modified: '2026-07-01T10:00:00.000Z',
      })
    })
    await act(async () => root.render(<Files />))
    await act(async () => row('personal/logo.png').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/file/raw?path=personal%2Flogo.png')
    await act(async () => {
      // A byte body uses the fetch implementation's own Blob realm when
      // Files calls response.blob(), which works on both Node 22 CI and Node 24.
      releasePreview(new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }))
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('does not discard a dirty file when the user cancels navigation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => root.render(<Files />))
    await act(async () => button('raw').click())
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'unsaved')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      row('personal/logo.png').click()
    })

    expect(window.confirm).toHaveBeenCalled()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('unsaved')
  })

  it('can block app navigation while the current file has unsaved changes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => root.render(<Files />))
    await act(async () => button('raw').click())
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'unsaved')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const allowed = window.dispatchEvent(new Event('contextcake:before-navigate', { cancelable: true }))
    expect(allowed).toBe(false)
    expect(window.confirm).toHaveBeenCalled()
  })

  it('explains an empty state when no source has files on disk', async () => {
    mocks.apiFetch.mockImplementation(async () => json({ layers: [] }))
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('No source keeps files on this machine')
  })
})

// ---- the source navigator ---------------------------------------------------

/** A layer whose files sit flat at the root, so every one of them is visible. */
function flatLayer(layer: string, count: number) {
  return {
    layer, kind: 'files', root: `/vault/${layer}`, fileCount: count, truncated: false,
    files: Array.from({ length: count }, (_, i) => {
      const rel = `note-${String(i).padStart(5, '0')}.md`
      return { path: `${layer}/${rel}`, name: rel, rel, ext: '.md', kind: 'text', markdown: true }
    }),
  }
}

/** A layer with real nesting, for the collapse/expand contract. */
const NESTED = {
  layers: [{
    layer: 'vault', kind: 'files', root: '/vault', fileCount: 3, truncated: false,
    files: [
      { path: 'vault/README.md', name: 'README.md', rel: 'README.md', ext: '.md', kind: 'text', markdown: true },
      { path: 'vault/Projects/alpha.md', name: 'alpha.md', rel: 'Projects/alpha.md', ext: '.md', kind: 'text', markdown: true },
      { path: 'vault/Projects/deep/beta.md', name: 'beta.md', rel: 'Projects/deep/beta.md', ext: '.md', kind: 'text', markdown: true },
    ],
  }],
}

/**
 * One file `depth` folders down, with the `rel` that reaches it. Nothing bounds
 * nesting — the engine's walk caps files, not depth — so a docs monorepo or a
 * foldered vault gets here on its own.
 */
function deepLayer(depth: number) {
  const rel = `${Array.from({ length: depth }, (_, i) => `level-${i + 1}`).join('/')}/buried.md`
  const listing = {
    layers: [{
      layer: 'vault', kind: 'files', root: '/vault', fileCount: 1, truncated: false,
      files: [{ path: `vault/${rel}`, name: 'buried.md', rel, ext: '.md', kind: 'text', markdown: true }],
    }],
  }
  return { rel, listing }
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

const active = () => document.activeElement as HTMLElement | null

describe('Files navigator tree', () => {
  it('renders a 5,000-file source without putting 5,000 rows in the DOM', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 5000)] })
      return json({ ...MEETING, path: 'vault/note-00000.md', rel: 'note-00000.md' })
    })
    await act(async () => root.render(<Files />))

    // 5,000 files plus the layer root: the scrollable height claims all of it,
    // while the DOM holds only the window.
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    expect(tree.style.height).toBe(`${5001 * 28}px`)
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(500)
  })

  it('keeps a row 20 folders deep readable instead of indenting its name to nothing', async () => {
    const DEPTH = 20
    const { rel, listing } = deepLayer(DEPTH)
    mocks.store.query = 'buried' // a filter opens every folder, which is how you reach a deep row
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(listing)
      return json({ ...MEETING, path: `vault/${rel}`, rel })
    })
    await act(async () => root.render(<Files />))

    const leaf = row(`vault/${rel}`)
    expect(leaf.querySelector('.cc-tree-name')?.textContent).toBe('buried.md')

    // The navigator column is minmax(220px, 300px) and .cc-tree-scroll adds
    // 12px of horizontal padding, so a row is 208px wide at its narrowest.
    // jsdom lays nothing out, so assert the one number that decides whether a
    // name gets any width at all: the indent has to leave room for the twisty,
    // the gap, the row's right padding and the name's own 4ch floor. Unclamped,
    // depth 21 asks for 281px of a 208px row and the name renders at zero.
    const NARROWEST_ROW = 220 - 12
    const CHROME = 12 + 6 + 8 // leaf icon, gap, right padding
    const NAME_FLOOR = 4 * 6.7 // .cc-tree-name min-width: 4ch, 11px JetBrains Mono
    expect(Number.parseFloat(leaf.style.paddingLeft)).toBeLessThanOrEqual(NARROWEST_ROW - CHROME - NAME_FLOOR)

    // The picture flattens past the cap; the tree's own account of itself does
    // not. Screen readers read depth off aria-level, and it is still the truth.
    expect(leaf.getAttribute('aria-level')).toBe(String(DEPTH + 2))
  })

  it('collapses and expands a folder', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(NESTED)
      return json({ ...MEETING, path: 'vault/README.md', rel: 'README.md' })
    })
    await act(async () => root.render(<Files />))

    // Folders start closed; the layer root does not.
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[title="vault/Projects/alpha.md"]')).toBeNull()

    await act(async () => row('vault/Projects').click())
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('true')
    expect(row('vault/Projects/alpha.md')).toBeTruthy()
    // One level only — the nested folder is its own decision.
    expect(container.querySelector('[title="vault/Projects/deep/beta.md"]')).toBeNull()

    await act(async () => row('vault/Projects').click())
    expect(container.querySelector('[title="vault/Projects/alpha.md"]')).toBeNull()
  })

  it('is a keyboard tree: arrows move, expand, collapse, and reach the parent', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(NESTED)
      return json({ ...MEETING, path: 'vault/README.md', rel: 'README.md' })
    })
    await act(async () => root.render(<Files />))

    const start = row('vault')
    expect(start.getAttribute('tabindex')).toBe('0') // exactly one tab stop
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)

    await act(async () => press(start, 'ArrowDown'))
    expect(active()?.title).toBe('vault/Projects')

    await act(async () => press(active()!, 'ArrowRight')) // expands
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('true')
    await act(async () => press(active()!, 'ArrowRight')) // now moves to first child
    expect(active()?.title).toBe('vault/Projects/deep')

    await act(async () => press(active()!, 'ArrowLeft')) // collapsed already → parent
    expect(active()?.title).toBe('vault/Projects')
    await act(async () => press(active()!, 'ArrowLeft')) // expanded → collapse
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('false')

    await act(async () => press(active()!, 'End'))
    expect(active()?.title).toBe('vault/README.md')
    await act(async () => press(active()!, 'Enter'))
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/file?path=vault%2FREADME.md', expect.anything())
  })

  it('keeps keyboard focus alive across the virtualization boundary', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 5000)] })
      return json({ ...MEETING, path: 'vault/note-00000.md', rel: 'note-00000.md' })
    })
    await act(async () => root.render(<Files />))

    await act(async () => row('vault').focus())
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- one keystroke at a time is the point
      await act(async () => press(active()!, 'ArrowDown'))
    }

    // Row 60 is far outside the first window. Focus is on it, it is in the DOM,
    // and the DOM is still small — the row is rendered *because* it has focus.
    expect(active()?.getAttribute('role')).toBe('treeitem')
    expect(active()?.title).toBe('vault/note-00059.md')
    expect(document.activeElement).not.toBe(document.body)
    expect(rows().length).toBeLessThan(500)
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)

    // And back up: still focused, still one tab stop, still bounded.
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ditto
      await act(async () => press(active()!, 'ArrowUp'))
    }
    expect(active()?.title).toBe('vault')
    expect(rows().length).toBeLessThan(500)
  })

  it('keeps a focused row mounted when the list is scrolled past it', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 5000)] })
      return json({ ...MEETING, path: 'vault/note-00000.md', rel: 'note-00000.md' })
    })
    await act(async () => root.render(<Files />))
    await act(async () => row('vault').focus())
    await act(async () => press(active()!, 'ArrowDown'))
    const focused = active()!
    expect(focused.title).toBe('vault/note-00000.md')

    // The wheel, not the keyboard: nothing moved the focused row, the window
    // moved out from under it. Without the always-render rule for the active
    // row, this unmounts the focused node and focus falls back to <body>.
    const scroller = container.querySelector<HTMLElement>('.cc-tree-scroll')!
    Object.defineProperty(scroller, 'scrollTop', { value: 90_000, configurable: true, writable: true })
    await act(async () => scroller.dispatchEvent(new Event('scroll')))

    expect(rows().length).toBeLessThan(60)
    expect(rows().map((r) => r.title)).toContain('vault/note-00000.md')
    expect(document.activeElement).toBe(focused)
    expect(document.activeElement).not.toBe(document.body)
    // The window really did move — the focused row is stranded thousands of
    // rows behind it, not merely still in view.
    expect(rows().filter((r) => /note-03\d{3}\.md$/.test(r.title)).length).toBeGreaterThan(10)
  })

  it('emits rows in visual order, so browse mode reads the focused row in its place', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 5000)] })
      return json({ ...MEETING, path: 'vault/note-00000.md', rel: 'note-00000.md' })
    })
    await act(async () => root.render(<Files />))
    await act(async () => row('vault').focus())
    await act(async () => press(active()!, 'ArrowDown'))
    expect(active()?.title).toBe('vault/note-00000.md')

    // Rows are absolutely positioned, so the picture says nothing about whether
    // the accessibility tree agrees with it — and sequential reading of a
    // flattened role="tree" follows DOM order, not `top`.
    const tops = () => rows().map((r) => Number.parseFloat(r.style.top))
    const ascending = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1])

    expect(ascending(tops())).toBe(true)
    expect(rows()[rows().length - 1].title).not.toBe(active()?.title)

    // And once the window has moved past the focused row: still in the DOM —
    // that is the focus guarantee — and now first, which is where it belongs.
    const scroller = container.querySelector<HTMLElement>('.cc-tree-scroll')!
    Object.defineProperty(scroller, 'scrollTop', { value: 90_000, configurable: true, writable: true })
    await act(async () => scroller.dispatchEvent(new Event('scroll')))

    expect(document.activeElement).not.toBe(document.body)
    expect(rows()[0].title).toBe('vault/note-00000.md')
    expect(ascending(tops())).toBe(true)
  })

  it('opens a file on arrival without reorganizing the tree, but a deep link reveals its own', async () => {
    const nested = {
      layers: [{
        layer: 'vault', kind: 'files', root: '/vault', fileCount: 3, truncated: false,
        files: [
          { path: 'vault/Projects/alpha.md', name: 'alpha.md', rel: 'Projects/alpha.md', ext: '.md', kind: 'text', markdown: true },
          { path: 'vault/Projects/deep/beta.md', name: 'beta.md', rel: 'Projects/deep/beta.md', ext: '.md', kind: 'text', markdown: true },
        ],
      }],
    }
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(nested)
      return json({ ...MEETING, path: 'vault/Projects/alpha.md', rel: 'Projects/alpha.md' })
    })
    await act(async () => root.render(<Files />))

    // A file is open — the detail pane is never blank — but the folder
    // overview is intact: nothing the user did not ask for got expanded.
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/file?path=vault%2FProjects%2Falpha.md', expect.anything())
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('false')
    expect(rows()).toHaveLength(2)

    // The same file named in the URL is a request, and does reveal itself.
    // A fresh key remounts, so the deep-linked path is the arriving state.
    mocks.store.path = 'vault/Projects/deep/beta.md'
    await act(async () => root.render(<Files key="deep-link" />))
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('true')
    expect(row('vault/Projects/deep').getAttribute('aria-expanded')).toBe('true')
    expect(row('vault/Projects/deep/beta.md').getAttribute('aria-selected')).toBe('true')
  })

  it('scopes to one source and clears back to every source', async () => {
    mocks.store.sources = [
      { name: 'vault', layer: 'personal', sourceKind: 'files' },
      { name: 'team-docs', layer: 'team', sourceKind: 'files' },
    ]
    mocks.store.scope = 'vault'
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 3), flatLayer('team-docs', 3)] })
      return json({ ...MEETING, path: 'vault/note-00000.md', rel: 'note-00000.md' })
    })
    await act(async () => root.render(<Files />))

    expect(row('vault')).toBeTruthy()
    expect(container.querySelector('[title="team-docs"]')).toBeNull()
    expect(container.textContent).toContain('/vault/vault') // the root path, in the chip

    const clear = container.querySelector<HTMLButtonElement>('.cc-scope-chip button')!
    expect(clear.getAttribute('aria-label')).toContain('every source')
    await act(async () => clear.click())

    expect(row('team-docs')).toBeTruthy()
    expect(container.querySelector('.cc-scope-chip')).toBeNull()
  })

  it('explains a scoped source that keeps nothing on this machine', async () => {
    mocks.store.sources = [
      { name: 'vault', layer: 'personal', sourceKind: 'files' },
      { name: 'company-graph', layer: 'company', sourceKind: 'mcp' },
    ]
    mocks.store.scope = 'company-graph'
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json({ layers: [flatLayer('vault', 3)] })
      return json(MEETING)
    })
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('company-graph keeps no files here')
    expect(container.textContent).toContain('remote knowledge graph over MCP')
    expect(container.querySelector('[role="tree"]')).toBeNull()
  })

  it('opens every folder while a search is active, and says so when nothing matches', async () => {
    mocks.store.query = 'beta'
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(NESTED)
      return json({ ...MEETING, path: 'vault/Projects/deep/beta.md', rel: 'Projects/deep/beta.md' })
    })
    await act(async () => root.render(<Files />))

    // A filtered tree is useless closed: the match is four levels down.
    expect(row('vault/Projects/deep/beta.md')).toBeTruthy()
    expect(container.querySelector('[title="vault/README.md"]')).toBeNull()

    mocks.store.query = 'zzzz'
    mocks.store.sources = [{ name: 'vault', layer: 'personal', sourceKind: 'files' }]
    await act(async () => root.render(<Files />))
    expect(container.textContent).toContain('Nothing matches that')
  })

  it('still collapses a folder while a search is running', async () => {
    // A filter opens every folder because every remaining row matched — but as
    // a default, not a veto. Treated as a veto it left ArrowLeft unable to do
    // anything but "collapse" (which then did nothing), so it could never walk
    // to the parent, and a click on a folder was a visible no-op.
    mocks.store.query = 'a' // matches every path below
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(NESTED)
      return json({ ...MEETING, path: 'vault/Projects/alpha.md', rel: 'Projects/alpha.md' })
    })
    await act(async () => root.render(<Files />))

    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('true')
    const opened = rows().length

    await act(async () => row('vault/Projects').click())
    expect(row('vault/Projects').getAttribute('aria-expanded')).toBe('false')
    expect(rows().length).toBeLessThan(opened)
    expect(container.querySelector('[title="vault/Projects/deep"]')).toBeNull()

    // ...and the keyboard agrees: collapsed already, so ArrowLeft walks up.
    await act(async () => row('vault/Projects').focus())
    await act(async () => press(active()!, 'ArrowLeft'))
    expect(active()?.title).toBe('vault')
  })

  it('hands focus to the row that inherits the tab stop, but never takes it from the search box', async () => {
    // The listing is refetched in the background, so the row under the cursor
    // can be deleted out from under the keyboard. The tab stop moves to the
    // first row; focus, left behind on a node that no longer exists, falls to
    // <body> and the keyboard goes dead with no way back but the mouse.
    const PRUNED = {
      layers: [{ ...NESTED.layers[0], fileCount: 2, files: NESTED.layers[0].files.slice(0, 2) }],
    }
    let listing: unknown = NESTED
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/files') return json(listing)
      return json({ ...MEETING, path: 'vault/Projects/deep/beta.md', rel: 'Projects/deep/beta.md' })
    })
    await act(async () => root.render(<Files />))

    await act(async () => row('vault').focus())
    await act(async () => press(active()!, 'ArrowDown'))
    await act(async () => press(active()!, 'ArrowRight')) // expand Projects
    await act(async () => press(active()!, 'ArrowRight')) // → vault/Projects/deep
    expect(active()?.title).toBe('vault/Projects/deep')

    listing = PRUNED
    mocks.store.reloadKey = 1
    await act(async () => root.render(<Files />))

    expect(container.querySelector('[title="vault/Projects/deep"]')).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(active()?.getAttribute('role')).toBe('treeitem')
    expect(active()?.getAttribute('tabindex')).toBe('0')
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)

    // The same reset usually fires while the user is typing in the search box —
    // where taking focus would be worse than the bug. Focus is tracked as it
    // moves, so a tree that has already handed focus away does not take it back.
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    expect(document.activeElement).toBe(box)

    mocks.store.query = 'alpha' // drops every row but vault/Projects/alpha.md
    await act(async () => root.render(<Files />))
    expect(container.querySelector('[title="vault/README.md"]')).toBeNull()
    expect(document.activeElement).toBe(box)
    box.remove()
  })
})

describe('Files in the demo', () => {
  beforeEach(() => { mocks.store.mode = 'demo' })

  it('renders the navigator over the build-time snapshot, with no engine behind it', async () => {
    await act(async () => root.render(<Files />))

    // Every layer in the generated listing gets a root row carrying its count.
    for (const layer of demoFiles.layers) {
      expect(row(layer.layer).getAttribute('aria-expanded')).toBe('true')
      expect(row(layer.layer).textContent).toContain(String(layer.fileCount))
    }
    // A real tree, not a flat list: folders are there and start closed.
    expect(row('personal/decisions').getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[title="personal/decisions/primary-db.md"]')).toBeNull()

    // The first document is open and rendered from the snapshot's own text.
    expect(container.querySelector('.cc-md')?.textContent).toContain('Postgres in every shared environment')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('offers no way to write, and says why', async () => {
    await act(async () => root.render(<Files />))

    expect(() => button('Save')).toThrow()
    expect(container.textContent).toContain('read-only in the demo')

    // The raw tab still shows the source — reading is the whole point — but the
    // editor cannot take a keystroke it would have to throw away.
    await act(async () => button('raw').click())
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(editor.readOnly).toBe(true)
    expect(editor.getAttribute('aria-label')).toContain('read-only')
    expect(() => button('Save')).toThrow()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('lists a binary the snapshot cannot carry instead of hiding it', async () => {
    await act(async () => root.render(<Files />))
    await act(async () => row('company/assets').click())
    await act(async () => row('company/assets/contextcake-brief.pdf').click())

    expect(container.textContent).toContain('Not in the demo snapshot')
    // Never the forever-spinner: no raw fetch is attempted in the first place.
    expect(container.textContent).not.toContain('Loading preview…')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })
})

describe('Files → concept', () => {
  it('links an open document to the concept it resolves to, conflicts named not just coloured', async () => {
    mocks.store.concepts = [{
      id: 'meeting',
      title: 'Weekly sync',
      type: 'note',
      layers: ['personal'],
      sections: [
        { name: 'Decision', winner: 'personal', sourceLayer: 'personal', value: 'x', dissents: [{ layer: 'team', sourceLayer: 'team-docs', value: 'y' }] },
        { name: 'Owner', winner: 'personal', sourceLayer: 'personal', value: 'z', dissents: [] },
      ],
    }]
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('Resolves to')
    // The count is words, not a hue — the a11y rule this strip has to keep.
    expect(container.textContent).toContain('1 conflict')

    await act(async () => button('Weekly syncmeeting').click())
    expect(mocks.openConcept).toHaveBeenCalledWith('meeting')
  })

  it('offers no strip for a file the cascade does not read', async () => {
    // Same file, no matching concept id: the cascade genuinely does not serve
    // it, and a link to a concept that isn't there would be a lie.
    mocks.store.concepts = [{ id: 'something-else', title: 'Other', type: 'note', layers: ['personal'], sections: [] }]
    await act(async () => root.render(<Files />))

    expect(container.textContent).not.toContain('Resolves to')
  })

  it('walks from a demo document to its concept, and offers nothing for the file the cascade skips', async () => {
    mocks.store.mode = 'demo'
    // Ids straight from the generated cascade, so this can only pass while the
    // two halves of the demo bundle are built from the same corpus.
    mocks.store.concepts = demoBundle.concepts.map((c) => ({
      id: c.id,
      title: (c.frontmatter?.title as string) ?? c.id,
      type: 'concept',
      layers: ['personal'],
      sections: [],
    }))
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('Resolves to')
    expect(container.textContent).toContain('decisions/primary-db')

    // A .txt in an OKF bundle is read by no adapter, so it has no concept —
    // and the strip says nothing rather than linking somewhere that isn't there.
    await act(async () => row('personal/notes').click())
    await act(async () => row('personal/notes/scratch.txt').click())
    expect(container.textContent).not.toContain('Resolves to')
  })

  it('hides Reveal in Finder outside the desktop app, and reveals a layer-relative path inside it', async () => {
    mocks.store.concepts = []
    await act(async () => root.render(<Files />))
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Reveal in Finder')).toBe(false)

    const revealFile = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP = { revealFile }
    await act(async () => root.render(<Files key="desktop" />))
    await act(async () => button('Reveal in Finder').click())
    // A source name and a path inside it — never an absolute path.
    expect(revealFile).toHaveBeenCalledWith('personal', 'meeting.md')

    revealFile.mockResolvedValue({ ok: false, error: 'That path is outside the folder for “personal”.' })
    await act(async () => button('Reveal in Finder').click())
    expect(container.textContent).toContain('outside the folder')
    delete (window as unknown as { __CC_DESKTOP?: unknown }).__CC_DESKTOP
  })
})
