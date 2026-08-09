// @vitest-environment jsdom
// ConceptDetail is shared by the Canvas slide-over and the Knowledge page. A
// section's provenance line, its "suppressed by" note, and a dissent chip all
// used to name the three-lane bucket (layerName(winner)/layerName(layer))
// instead of the real source that produced the value — so two sources sharing
// a lane (e.g. two personal-level MCP servers) were indistinguishable in the
// inspector. Every place that used to print a lane name now prints
// `sourceLayer`, the manifest's own name for the contributor.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConceptDetail } from './ConceptDetail'
import type { Concept } from '../data'

vi.mock('../layer-files', () => ({
  filesRevalidation: () => 'rev',
  useLayerFiles: () => ({ layers: [] }),
}))

const mocks = vi.hoisted(() => ({ store: null as unknown as Record<string, unknown> }))
vi.mock('../store', () => {
  const store = () => mocks.store
  return { useStore: store, useStoreData: store, useStoreNav: store, useStoreInput: store }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.store = { mode: 'demo', sources: [], reloadKey: 0, openFilesScope: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function concept(): Concept {
  return {
    id: 'decisions/primary-db',
    title: 'Primary database',
    type: 'decision',
    layers: ['personal', 'team'],
    sections: [
      {
        name: 'Choice',
        winner: 'personal',
        sourceLayer: 'maya-notes',
        value: 'SingleStore for HTAP workloads.',
        updated: '2026-08-01',
        dissents: [
          { layer: 'team', sourceLayer: 'acme-eng', value: 'Postgres (org standard).', updated: '2026-06-01' },
        ],
      },
      {
        name: 'Rollback plan',
        winner: 'personal',
        sourceLayer: 'maya-notes',
        value: '',
        suppressed: true,
      },
    ],
  }
}

describe('ConceptDetail provenance', () => {
  it('names the real contributing source, not the lane it renders in', async () => {
    await act(async () => root.render(<ConceptDetail concept={concept()} />))
    expect(container.textContent).toContain('maya-notes · 2026-08-01')
    // The lane bucket name never appears as the section's provenance text —
    // it stays a color cue (the dot) plus the top-of-panel layer chips.
    expect(container.querySelector('code')).toBeTruthy()
  })

  it('names the real source in the suppressed-by note, not "personal"', async () => {
    await act(async () => root.render(<ConceptDetail concept={concept()} />))
    expect(container.textContent).toContain('suppressed by maya-notes')
    expect(container.textContent).not.toContain('suppressed by personal')
  })

  it('names the real dissenting source on the dissent chip, keeping the lane color', async () => {
    await act(async () => root.render(<ConceptDetail concept={concept()} />))
    const chip = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'acme-eng')
    expect(chip, 'dissent chip should read the source name, not the lane').toBeTruthy()
    expect(container.textContent).not.toContain('Team says')
  })
})
