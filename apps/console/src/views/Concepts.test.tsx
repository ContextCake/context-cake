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

/** A graph-first row that has not fetched its document yet. */
function compact(): Concept {
  return {
    id: 'decisions/pending-note', title: 'Pending note', type: 'note',
    layers: ['personal'], contributorLayers: ['personal'], sections: [], detailLoaded: false,
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

it('guides the reader to choose a result without selecting or fetching one', async () => {
  mocks.useLayerFiles.mockClear()
  const store = storeWith([populated()], '')
  mocks.useStore.mockReturnValue(store)
  await act(async () => root.render(<Concepts />))
  expect(container.querySelector('[aria-label="Concept reader"]')?.textContent).toContain('Choose a result')
  expect(container.textContent).toContain('Inspect its current answer, sources, and alternatives.')
  expect(store.setSelConcept).not.toHaveBeenCalled()
  expect(mocks.useLayerFiles).not.toHaveBeenCalled()
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

    const rows = Array.from(container.querySelectorAll('.cc-concept-result'))
    const emptyRow = rows.find((row) => row.textContent?.includes('Empty note'))
    const populatedRow = rows.find((row) => row.textContent?.includes('Primary database'))
    expect(emptyRow?.textContent).toContain('empty')
    expect(populatedRow?.textContent).not.toContain('empty')
  })

  it('does not call a row empty before its document has loaded', async () => {
    // Graph-first bootstrap gives every row zero sections until it is opened.
    // Labelling those "empty" would mark a whole vault as dead ends.
    mocks.useStore.mockReturnValue(storeWith([compact()], 'decisions/pending-note'))
    await act(async () => root.render(<Concepts />))

    const rows = Array.from(container.querySelectorAll('.cc-concept-result'))
    const pending = rows.find((row) => row.textContent?.includes('Pending note'))
    expect(pending).toBeTruthy()
    expect(pending?.textContent).not.toContain('empty')
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
    return Array.from(container.querySelectorAll('.cc-concept-result'))
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

  it('searches each source/type scope before accepting content matches and clears the previous scope immediately', async () => {
    const a = populated()
    const b = { ...empty(), contributorLayers: ['specs'] }
    const hit = (c: Concept) => ({ id: c.id, title: c.title, score: 5, layers: c.contributorLayers, snippet: '<!-- source: auto -->Use <b>build and test</b> commands.' })
    const search = vi.fn().mockResolvedValueOnce([hit(a)]).mockResolvedValueOnce([hit(b)]).mockResolvedValueOnce([])
    mocks.useStore.mockReturnValue({ ...liveStoreWith([a, b], 'build and test', search), sources: [{ name: 'personal' }, { name: 'specs' }] })
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(rows()).toHaveLength(1)
    const source = container.querySelector<HTMLSelectElement>('[aria-label="Filter concepts by source"]')!
    await act(async () => { source.value = 'specs'; source.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('Searching content')
    expect(container.textContent).not.toContain('No matches in titles or content.')
    expect(rows()).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(search).toHaveBeenLastCalledWith('build and test', 20, { source: 'specs', type: undefined })
    expect(rows()[0].textContent).toContain(b.title)
    expect(container.querySelector('.cc-result-snippet')?.textContent).toBe('Use <b>build and test</b> commands.')
    const type = container.querySelector<HTMLSelectElement>('[aria-label="Filter concepts by type"]')!
    await act(async () => { type.value = 'decision'; type.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('Searching content')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(search).toHaveBeenLastCalledWith('build and test', 20, { source: 'specs', type: 'decision' })
    expect(rows()).toHaveLength(0)
  })

  it('preserves code generics and command placeholders while removing metadata comments from excerpts', async () => {
    const concept = populated()
    const snippet = '<!-- source: auto --> Return Promise<Result> from load<T>() and --config <file>.'
    const search = vi.fn().mockResolvedValue([{ id: concept.id, title: concept.title, score: 5, layers: ['personal'], snippet }])
    mocks.useStore.mockReturnValue(liveStoreWith([concept], 'load', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(rows()[0].querySelector('.cc-result-snippet')?.textContent).toBe('Return Promise<Result> from load<T>() and --config <file>.')
    expect(rows()[0].querySelector('.cc-result-snippet result')).toBeNull()
  })

  it('distinguishes the original search excerpt from the policy-selected resolved answer', async () => {
    const concept = populated()
    concept.sections[0] = { ...concept.sections[0], sourceLayer: 'team', winner: 'team', value: 'Use SQLite.', contextResolution: { decisionId: 'decision-1', policyId: 'policy-1', status: 'applied', selectedSource: 'team' } }
    const search = vi.fn().mockResolvedValue([{ id: concept.id, title: concept.title, score: 5, layers: ['personal'], snippet: 'Use PostgreSQL.' }])
    mocks.useStore.mockReturnValue(liveStoreWith([concept], 'database', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(rows()[0].querySelector('.cc-result-excerpt-label')?.textContent).toBe('Original source excerpt')
    expect(rows()[0].querySelector('.cc-result-snippet')?.textContent).toBe('Use PostgreSQL.')
    expect(container.textContent).toContain('Open a result for the current resolved answer')
    await act(async () => rows()[0].click())
    const reader = container.querySelector('[aria-label="Primary database concept detail"]')!
    expect(reader.textContent).toContain('Use SQLite.')
    expect(reader.textContent).toContain('Source policy applied: team.')
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

  it('labels title-only results when the engine call fails', async () => {
    // The store's search() action never throws — a failed engine call
    // resolves to null, which is exactly what this exercises.
    const search = vi.fn().mockResolvedValue(null)
    mocks.useStore.mockReturnValue(liveStoreWith([populated()], 'primary', search))
    await act(async () => root.render(<Concepts />))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    // Substring match on the title still renders; no error, no empty state.
    expect(rows()).toHaveLength(1)
    expect(container.textContent).toContain('Primary database')
    expect(container.textContent).toContain('Content search unavailable')
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
    const setSelConcept = vi.fn()
    const store = { ...liveStoreWith([a, b], 'primary', search), setSelConcept }
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

    // `a`'s stale hit and its detail must both be gone immediately — well
    // before the new debounced search resolves.
    const list = rows().map((r) => r.textContent ?? '')
    expect(list.some((text) => text.includes('Primary database'))).toBe(false)
    expect(list.some((text) => text.includes('Other decision'))).toBe(true)
    expect(setSelConcept).toHaveBeenCalledWith('')
    expect(container.querySelector('[aria-label="Primary database concept detail"]')).toBeNull()

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

describe('bounded, evidence-rich search', () => {
  it('mounts a bounded set of 10,000 results and keeps keyboard navigation available', async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ ...populated(), id: `notes/${i}`, title: `Note ${i}` }))
    mocks.useStore.mockReturnValue(storeWith(many, ''))
    await act(async () => root.render(<Concepts />))
    expect(container.querySelectorAll('.cc-concept-result').length).toBeLessThan(30)
    const first = container.querySelector<HTMLButtonElement>('.cc-concept-result')!
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(container.querySelector('[data-result-index="9999"]')).toBeTruthy()
    expect(container.querySelectorAll('.cc-concept-result').length).toBeLessThan(30)
  })

  it('does not declare an empty result before the delayed content search completes', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (hits: SearchHit[]) => void
      const search = vi.fn(() => new Promise<SearchHit[]>((resolve) => { finish = resolve }))
      mocks.useStore.mockReturnValue({ ...storeWith([populated()], ''), mode: 'live', query: 'htap', search })
      await act(async () => root.render(<Concepts />))
      expect(container.textContent).toContain('Searching your sources')
      expect(container.textContent).not.toContain('No matching concepts')
      await act(async () => vi.advanceTimersByTimeAsync(250))
      await act(async () => finish([{ id: populated().id, title: null, score: 4, layers: ['engineering-notes'], snippet: 'SingleStore supports HTAP workloads.' }]))
      expect(container.textContent).toContain('SingleStore supports HTAP workloads.')
      expect(container.textContent).toContain('engineering-notes')
    } finally { vi.useRealTimers() }
  })
})

describe('Library workbench toolbar', () => {
  it('keeps search above both panes and focuses it from the app search command even with an empty corpus', async () => {
    mocks.useStore.mockReturnValue({ ...storeWith([], ''), setQuery: vi.fn() })
    await act(async () => root.render(<Concepts />))
    const field = container.querySelector<HTMLInputElement>('[data-context-search]')!
    expect(field.closest('.cc-library-toolbar')).toBeTruthy()
    expect(field.closest('.cc-navigator-detail')).toBeNull()
    expect(container.textContent).toContain('No concepts yet')
    window.dispatchEvent(new Event('contextcake:focus-search'))
    expect(document.activeElement).toBe(field)
  })

  it('updates the shared query while typing and Escape clears it without closing the workspace', async () => {
    const setQuery = vi.fn()
    mocks.useStore.mockReturnValue({ ...storeWith([populated()], ''), query: 'database', setQuery })
    await act(async () => root.render(<Concepts />))
    const field = container.querySelector<HTMLInputElement>('[data-context-search]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'deployment')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(setQuery).toHaveBeenCalledWith('deployment')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => field.dispatchEvent(escape))
    expect(setQuery).toHaveBeenLastCalledWith('')
    expect(escape.defaultPrevented).toBe(true)
  })

  it('offers one way back from an empty scoped result and restores search focus', async () => {
    const setQuery = vi.fn()
    mocks.useStore.mockReturnValue({ ...storeWith([populated()], ''), query: 'no-match', setQuery, sources: [{ name: 'personal' }] })
    await act(async () => root.render(<Concepts />))
    const source = container.querySelector<HTMLSelectElement>('[aria-label="Filter concepts by source"]')!
    await act(async () => { source.value = 'personal'; source.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Clear search and filters')!.click())
    expect(setQuery).toHaveBeenCalledWith('')
    expect(source.value).toBe('')
    expect(document.activeElement).toBe(container.querySelector('[data-context-search]'))
  })

  it('keeps roving keyboard navigation and selection in the bounded results pane', async () => {
    const store = storeWith([populated(), empty()], '')
    mocks.useStore.mockReturnValue({ ...store, setQuery: vi.fn() })
    await act(async () => root.render(<Concepts />))
    const first = container.querySelector<HTMLButtonElement>('[data-result-index="0"]')!
    await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    const last = container.querySelector<HTMLButtonElement>('[data-result-index="1"]')!
    expect(last.tabIndex).toBe(0)
    expect(first.tabIndex).toBe(-1)
    await act(async () => last.click())
    expect(store.setSelConcept).toHaveBeenCalledWith('decisions/empty-note')
  })
})
