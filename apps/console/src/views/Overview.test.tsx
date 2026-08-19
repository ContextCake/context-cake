// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Overview } from './Overview'

const mocks = vi.hoisted(() => ({ useStore: vi.fn(), setView: vi.fn() }))
vi.mock('../store', () => ({ useStore: mocks.useStore, useStoreData: mocks.useStore, useStoreNav: mocks.useStore, useStoreInput: mocks.useStore, useStoreChat: mocks.useStore }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.setView.mockReset()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('prioritizes actionable work and never renders fixture activity in live mode', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [{ id: 'q', route: 'review_required' }],
    conflicts: [{ id: 'c', status: 'open', contributions: [] }],
    sources: [{ name: 'docs', status: 'error', error: 'Source failed exactly', layer: 'team', conceptCount: 0 }],
    concepts: [], activity: [{ strong: 'fixture should not render' }],
    loadErrors: [{ concept: 'x', error: 'partial' }],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Needs Attention')
  expect(container.textContent).toContain('Source failed exactly')
  expect(container.textContent).not.toContain('fixture should not render')
  const conflict = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('actionable discrepancy'))
  await act(async () => conflict?.click())
  expect(mocks.setView).toHaveBeenCalledWith('conflicts')
})

it('shows a calm resolved state when nothing needs review', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Nothing needs review')
})

// The MCP connect entry point only exists where App.tsx wires it in (desktop
// mode) — Overview must stay silent about it otherwise rather than offering a
// dead button.
it('offers no agent-connect entry point when onConnectAgent is not supplied', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).not.toContain('Connect an agent')
})

it('surfaces a prominent Connect an agent CTA when onConnectAgent is supplied', async () => {
  mocks.useStore.mockReturnValue({ mode: 'demo', setView: mocks.setView, signals: [], conflicts: [], sources: [], concepts: [], activity: [], loadErrors: [] })
  const onConnectAgent = vi.fn()
  await act(async () => root.render(<Overview onConnectAgent={onConnectAgent} />))
  const cta = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Connect an agent')
  expect(cta).toBeDefined()
  await act(async () => cta?.click())
  expect(onConnectAgent).toHaveBeenCalledOnce()
})

// The Cascade order section is the real cascade, position 1 first, one row
// per source: its name, its rank, and who it wins over. Never the manifest
// level (F3 named a level-1 source as itself; this pass stops showing the
// number at all) and never the static "runbooks, decisions, system docs" blurb.
it('lists every source in cascade order with its position and what it wins over', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [
      { name: 'company-graph', status: 'serving', layer: 'company', level: 0, conceptCount: 126, sourceKind: 'mcp' },
      { name: 'messy-vault', status: 'synced', layer: 'personal', level: 1, conceptCount: 4, sourceKind: 'files' },
    ],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).toContain('Cascade order')
  expect(container.textContent).toContain('Position 1 wins wherever it speaks')
  const rows = Array.from(container.querySelectorAll('.cc-cascade-order > li')).map((row) => row.textContent ?? '')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('#1')
  expect(rows[0]).toContain('messy-vault')
  expect(rows[0]).toContain('Wins over company-graph')
  expect(rows[0]).toContain('4 concepts')
  expect(rows[1]).toContain('#2')
  expect(rows[1]).toContain('company-graph')
  expect(rows[1]).toContain('Base — everything above inherits from it')
  expect(rows[1]).toContain('126 concepts')
  // The manifest integer never shows here — position is the only number.
  expect(container.querySelector('.cc-cascade-rank')?.textContent).toBe('#1')
  expect(container.textContent).not.toContain('level 1')
  expect(container.textContent).not.toContain('runbooks, decisions, system docs')
})

// A quarantined manifest entry contributes nothing to resolution, so it holds
// no position: it must not appear as "#2 (tied)" beside a real source.
it('leaves a quarantined entry out of the cascade order', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [
      { name: 'notes', status: 'synced', layer: 'personal', level: 3, conceptCount: 4, sourceKind: 'files' },
      { name: 'base', status: 'synced', layer: 'company', level: 0, conceptCount: 2, sourceKind: 'files' },
      { name: 'bad-kind', status: 'error', layer: 'company', level: 0, conceptCount: 0, sourceKind: 'notarealkind', quarantined: true, error: 'unsupported source kind' },
    ],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  const rows = Array.from(container.querySelectorAll('.cc-cascade-order > li')).map((row) => row.textContent ?? '')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('Wins over base')
  expect(rows[1]).toContain('Base — everything above inherits from it')
  expect(rows.join(' ')).not.toContain('bad-kind')
  expect(container.textContent).not.toContain('tied')
  // Still surfaced where it belongs — as something to fix.
  expect(container.textContent).toContain('bad-kind is error')
})

it('sends "Reorder in Sources" to the Sources view', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [{ name: 'notes', status: 'synced', layer: 'personal', level: 3, conceptCount: 4, sourceKind: 'files' }],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  const reorder = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reorder in Sources')
  expect(reorder).toBeDefined()
  await act(async () => reorder?.click())
  expect(mocks.setView).toHaveBeenCalledWith('sources')
})

// Demo mode renders the same real rows from its own sources — the static
// "runbooks, decisions, system docs" fallback is gone — but Sources is
// read-only there, so the button only offers a look, not a reorder.
it('renders real cascade rows in demo mode too, and does not promise a reorder', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'demo', setView: mocks.setView,
    signals: [], conflicts: [],
    sources: [
      { name: 'team', status: 'synced', layer: 'team', level: 2, conceptCount: 4, sourceKind: 'okf-local' },
      { name: 'personal', status: 'synced', layer: 'personal', level: 3, conceptCount: 2, sourceKind: 'okf-local' },
    ],
    concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  expect(container.textContent).not.toContain('Reorder in Sources')
  expect(container.textContent).toContain('Open Sources')
  const rows = Array.from(container.querySelectorAll('.cc-cascade-order > li')).map((row) => row.textContent ?? '')
  expect(rows[0]).toContain('#1')
  expect(rows[0]).toContain('personal')
  expect(rows[1]).toContain('#2')
  expect(rows[1]).toContain('team')
  expect(container.textContent).not.toContain('runbooks, decisions, system docs')
})

// The Discrepancies tile reads the engine's summary (actionable count) and
// says what kinds are behind it, largest first, zeros dropped.
it('counts actionable discrepancies on the tile with a per-kind subtitle', async () => {
  const conflicts = [
    { id: 'a', status: 'open', kind: 'broken_link', discrepancyStatus: 'needs_review', contributions: [] },
    { id: 'b', status: 'open', kind: 'broken_link', discrepancyStatus: 'reopened', contributions: [] },
    { id: 'c', status: 'open', kind: 'section_content', discrepancyStatus: 'recommended', contributions: [] },
    { id: 'd', status: 'open', kind: 'frontmatter_value', discrepancyStatus: 'acknowledged', contributions: [] },
  ]
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView, signals: [], conflicts,
    conflictSummary: { total: 4, actionable: 3, byKind: { section_content: 1, frontmatter_value: 1, broken_link: 2, changed_after_decision: 0 }, byStatus: {}, bySourcePair: [], byOwner: [], byConceptType: [], topTargets: [], topConcepts: [], quickWins: { autoReady: 0, recommended: 1, brokenLinksWithBestCandidate: 0, brokenLinksTotal: 2 } },
    sources: [], concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  const tile = Array.from(container.querySelectorAll('.cc-metric-strip button')).find((button) => button.textContent?.includes('Discrepancies'))!
  expect(tile.querySelector('strong')?.textContent).toBe('3')
  // Actionable per kind from the rows: the acknowledged frontmatter value is not counted.
  expect(tile.querySelector('.cc-metric-detail')?.textContent).toBe('2 broken links · 1 section')
  expect(container.textContent).toContain('3 actionable discrepancies')
})

it('falls back to a local summary when the store carries none (an older engine, or a partial store)', async () => {
  mocks.useStore.mockReturnValue({
    mode: 'live', setView: mocks.setView, signals: [],
    conflicts: [{ id: 'a', status: 'open', kind: 'broken_link', discrepancyStatus: 'needs_review', contributions: [] }],
    sources: [], concepts: [], activity: [], loadErrors: [],
  })
  await act(async () => root.render(<Overview />))
  const tile = Array.from(container.querySelectorAll('.cc-metric-strip button')).find((button) => button.textContent?.includes('Discrepancies'))!
  expect(tile.querySelector('strong')?.textContent).toBe('1')
  expect(tile.querySelector('.cc-metric-detail')?.textContent).toBe('1 broken link')
})
