// @vitest-environment jsdom
// The Knowledge: Concepts list and its detail panel — including the
// zero-section dead end (F18): a concept with no sections used to render an
// empty panel with no explanation and no way out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Concepts } from './Concepts'
import type { Concept } from '../data'
import type { SearchHit } from '../types'

const mocks = vi.hoisted(() => ({ useStore: vi.fn(), useLayerFiles: vi.fn() }))
vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore }))
vi.mock('../layer-files', () => ({
  filesRevalidation: () => 'rev',
  useLayerFiles: mocks.useLayerFiles,
}))

let container: HTMLDivElement
let root: Root

function storeWith(concepts: Concept[], selConcept: string, openFilesScope = vi.fn()) {
  return {
    mode: 'demo', sources: [], reloadKey: 0,
    query: '', concepts, selConcept,
    setSelConcept: vi.fn(), openFilesScope,
  }
}

function populated(): Concept {
  return {
    id: 'decisions/primary-db', title: 'Primary database', type: 'decision',
    layers: ['personal'], contributorLayers: ['personal'],
    sections: [{ name: 'Choice', winner: 'personal', sourceLayer: 'personal', value: 'SingleStore.', updated: '2026-01-01' }],
  }
}

function empty(): Concept {
  return {
    id: 'decisions/empty-note', title: 'Empty note', type: 'note',
    layers: ['personal'], contributorLayers: ['personal'], sections: [],
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label)
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.useLayerFiles.mockReturnValue({ layers: [] })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('a concept with no sections', () => {
  it('shows a quiet note and an Open file affordance instead of an empty panel', async () => {
    mocks.useStore.mockReturnValue(storeWith([empty()], 'decisions/empty-note'))
    mocks.useLayerFiles.mockReturnValue({
      layers: [{
        layer: 'personal', kind: 'files', root: '/vault', fileCount: 1, truncated: false,
        files: [{ path: 'personal/decisions/empty-note.md', name: 'empty-note.md', rel: 'decisions/empty-note.md', ext: '.md', kind: 'text', markdown: true }],
      }],
    })
    await act(async () => root.render(<Concepts />))

    expect(container.textContent).toContain('This concept has no sections — the file may be empty.')
    expect(button('Open file')).toBeTruthy()
  })

  it('falls back to a Files-tab affordance when no file is listed for the winning contributor', async () => {
    const openFilesScope = vi.fn()
    mocks.useStore.mockReturnValue(storeWith([empty()], 'decisions/empty-note', openFilesScope))
    await act(async () => root.render(<Concepts />))

    const browse = button('Browse personal in Files')
    expect(browse).toBeTruthy()
    await act(async () => browse?.click())
    expect(openFilesScope).toHaveBeenCalledWith('personal')
  })

  it('marks the concept "empty" in the list so it is triageable without opening it', async () => {
    mocks.useStore.mockReturnValue(storeWith([populated(), empty()], 'decisions/primary-db'))
    await act(async () => root.render(<Concepts />))

    const rows = Array.from(container.querySelectorAll('.cc-navigator-detail > div > button'))
    const emptyRow = rows.find((row) => row.textContent?.includes('Empty note'))
    const populatedRow = rows.find((row) => row.textContent?.includes('Primary database'))
    expect(emptyRow?.textContent).toContain('empty')
    expect(populatedRow?.textContent).not.toContain('empty')
  })
})

// WP-G: Knowledge search calls the engine's full-text /api/search in live
// mode, debounced, while the instant title/id substring filter (above) keeps
// serving the result until the engine answers or fails.
describe('Knowledge search (live mode)', () => {
  function liveStoreWith(concepts: Concept[], query: string, search = vi.fn()) {
    return {
      mode: 'live', sources: [], reloadKey: 0,
      query, concepts, selConcept: concepts[0]?.id ?? '',
      setSelConcept: vi.fn(), openFilesScope: vi.fn(), search,
    }
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('.cc-navigator-detail > div > button'))
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('debounces the query before calling the engine search', async () => {
    const search = vi.fn().mockResolvedValue([])
    mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'singlestore', search))
    await act(async () => root.render(<Concepts />))

    expect(search).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(249) })
    expect(search).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('singlestore')
  })

  it('narrows and reorders the list to the engine hits once they land', async () => {
    const a = populated()
    const b: Concept = { ...populated(), id: 'decisions/other', title: 'Other decision' }
    const search = vi.fn().mockResolvedValue([{ id: b.id, title: b.title, score: 5, layers: ['personal'], snippet: '' }])
    mocks.useStore.mockReturnValue(liveStoreWith([a, b], 'other', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    const list = rows()
    expect(list).toHaveLength(1)
    expect(list[0].textContent).toContain(b.title)
  })

  it('shows a content-search hint, not the title-only one, when the engine finds nothing', async () => {
    const search = vi.fn().mockResolvedValue([])
    mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'nomatch', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    expect(container.textContent).toContain('No matches in titles or content.')
  })

  it('falls back to the substring filter silently when the engine call fails', async () => {
    // The store's search() action never throws — a failed engine call
    // resolves to null, which is exactly what this exercises.
    const search = vi.fn().mockResolvedValue(null)
    mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'primary', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    // Substring match on the title still renders; no error, no empty state.
    expect(rows()).toHaveLength(1)
    expect(container.textContent).toContain('Primary database')
  })

  it('never calls the engine search in demo mode', async () => {
    const search = vi.fn()
    mocks.useStore.mockReturnValue({ ...liveStoreWith([populated()], 'primary', search), mode: 'demo' })
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    expect(search).not.toHaveBeenCalled()
    // Demo mode still gets the plain substring result.
    expect(rows()).toHaveLength(1)
  })

  // FIX 1: the engine has no prefix matching (BM25F over whole stemmed
  // tokens), so a mid-word query the engine misses must not blank a list the
  // substring filter would still populate.
  it('keeps a substring match visible when the engine answers empty on a partial word', async () => {
    const search = vi.fn().mockResolvedValue([])
    mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'prim', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    expect(search).toHaveBeenCalledWith('prim')
    expect(rows()).toHaveLength(1)
    expect(container.textContent).toContain('Primary database')
    expect(container.textContent).not.toContain('No matching concepts')
  })

  // FIX 2: engineHits from the PREVIOUS query must not survive a query
  // change — only the substring filter (recomputed synchronously) should
  // render until the new debounced answer lands.
  it('clears stale engine hits as soon as the query changes, before the new answer lands', async () => {
    const a = populated()
    const b: Concept = { ...populated(), id: 'decisions/other', title: 'Other decision' }
    let resolveSecond: (hits: SearchHit[]) => void = () => {}
    const search = vi.fn()
      .mockResolvedValueOnce([{ id: a.id, title: a.title, score: 5, layers: ['personal'], snippet: '' }])
      .mockImplementationOnce(() => new Promise<SearchHit[]>((resolve) => { resolveSecond = resolve }))
    const store = liveStoreWith([a, b], 'primary', search)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Primary database')])

    // Point the mocked store at a new query — `Concepts` is a props-less
    // `memo`, so a second `root.render()` call would bail out without ever
    // re-invoking it (verified: an external value change alone never
    // reaches a props-less memoized component here — only the component's
    // OWN state can force it to read the store hooks again). Dispatching the
    // close-detail event it already listens for triggers exactly that kind
    // of internal state update, forcing it to re-render and read the new
    // query — the same thing a real query keystroke does via context in the
    // live app.
    mocks.useStore.mockReturnValue({ ...store, query: 'other' })
    await act(async () => { window.dispatchEvent(new Event('contextcake:close-detail')) })

    // `a`'s stale hit from the first search must be gone immediately — well
    // before the new debounced search resolves. (The detail panel on the
    // right keeps showing whatever is still selected — that's unrelated to
    // this bug, so the assertion is scoped to the list rows.)
    const list = rows().map((r) => r.textContent ?? '')
    expect(list.some((text) => text.includes('Primary database'))).toBe(false)
    expect(list.some((text) => text.includes('Other decision'))).toBe(true)

    resolveSecond([])
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  })

  // FIX 5: the effect used to depend on both `q` (trimmed+lowercased) and
  // `query` (raw), so a trailing space or a capitalization change — neither
  // of which moves `q` — still re-ran it, and its setEngineHits(null) reset
  // fired a second, identical search while dropping the list to substring
  // order in between. Measured before the fix: 2 search calls for one
  // meaningful query, with the ranked list blanked between them.
  it('does not re-fire the search, or blank the ranked list, on a keystroke that leaves the normalized query unchanged', async () => {
    const a = populated()
    const b: Concept = { ...populated(), id: 'decisions/other', title: 'Other decision' }
    // Engine ranks b above a — a different order than substring/insertion
    // order — so a reset back to the substring list would be observable.
    const search = vi.fn().mockResolvedValue([
      { id: b.id, title: b.title, score: 5, layers: ['personal'], snippet: '' },
      { id: a.id, title: a.title, score: 1, layers: ['personal'], snippet: '' },
    ])
    const store = liveStoreWith([a, b], 'alpha', search)
    mocks.useStore.mockReturnValue(store)
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(search).toHaveBeenCalledTimes(1)
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining(b.title),
      expect.stringContaining(a.title),
    ])

    for (const nextQuery of ['alpha ', 'ALPHA']) {
      mocks.useStore.mockReturnValue({ ...store, query: nextQuery })
      await act(async () => { window.dispatchEvent(new Event('contextcake:close-detail')) })
      // Still the engine's ranked order, immediately — never reset to
      // substring order (which would be empty here) in between.
      expect(rows().map((r) => r.textContent)).toEqual([
        expect.stringContaining(b.title),
        expect.stringContaining(a.title),
      ])
      expect(search).toHaveBeenCalledTimes(1)
    }
  })

  // FIX 6: the union of engine hits + substring matches is right (it keeps
  // partial words alive — see the FIX 1 test above), but when the engine
  // answers precisely, its one ranked hit rendered visually indistinguishable
  // from the substring-only rows beneath it.
  describe('Top matches / Also contains divider', () => {
    it('shows both labels when the engine half and the substring-only half are both non-empty', async () => {
      const a = populated()
      const b: Concept = { ...populated(), id: 'decisions/other-primary', title: 'Other primary' }
      // The engine answers with only `a`; `b` reaches the list purely via the
      // substring filter (its id/title also contain "primary").
      const search = vi.fn().mockResolvedValue([{ id: a.id, title: a.title, score: 5, layers: ['personal'], snippet: '' }])
      mocks.useStore.mockReturnValue(liveStoreWith([a, b], 'primary', search))
      await act(async () => root.render(<Concepts />))
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(rows()).toHaveLength(2)
      expect(container.textContent).toContain('Top matches')
      expect(container.textContent).toContain('Also contains')
    })

    it('hides both labels when the engine half is empty (substring-only)', async () => {
      const search = vi.fn().mockResolvedValue([])
      mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'primary', search))
      await act(async () => root.render(<Concepts />))
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(rows()).toHaveLength(1)
      expect(container.textContent).not.toContain('Top matches')
      expect(container.textContent).not.toContain('Also contains')
    })

    it('hides both labels when the engine half already covers every row (nothing substring-only left)', async () => {
      const a = populated()
      const search = vi.fn().mockResolvedValue([{ id: a.id, title: a.title, score: 5, layers: ['personal'], snippet: '' }])
      mocks.useStore.mockReturnValue(liveStoreWith([a], 'primary', search))
      await act(async () => root.render(<Concepts />))
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(rows()).toHaveLength(1)
      expect(container.textContent).not.toContain('Top matches')
      expect(container.textContent).not.toContain('Also contains')
    })
  })
})
