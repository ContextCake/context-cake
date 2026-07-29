// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Files } from './Files'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), reload: vi.fn(), store: { mode: 'live', sources: [] as unknown[] } }))

vi.mock('../api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../store', () => ({
  useStore: () => ({ mode: mocks.store.mode, sources: mocks.store.sources, reload: mocks.reload }),
}))

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
  mocks.store.mode = 'live'
  mocks.store.sources = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/files') return json(FILES)
    if (url.startsWith('/api/file/raw?')) return new Response(new Blob(['image']), { status: 200, headers: { 'content-type': 'image/png' } })
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
    await act(async () => button('logo.png').click())

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/file/raw?path=personal%2Flogo.png')
    await act(async () => {
      releasePreview(new Response(new Blob(['image']), { status: 200, headers: { 'content-type': 'image/png' } }))
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
      button('logo.png').click()
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

  it('tells demo users why there is nothing to edit', async () => {
    mocks.store.mode = 'demo'
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('live-mode view')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('explains an empty state when no source has files on disk', async () => {
    mocks.apiFetch.mockImplementation(async () => json({ layers: [] }))
    await act(async () => root.render(<Files />))

    expect(container.textContent).toContain('No file-backed sources yet')
  })
})
