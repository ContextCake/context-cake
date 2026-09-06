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

describe('structured and bounded reading', () => {
  it('renders safe Markdown, including code and lists, for effective and alternate values', async () => {
    const doc = concept()
    doc.sections[0].value = 'Use **the build**:\n\n- Check sources\n\n```sh\nnpm test\n```\n\n<script>alert(1)</script>'
    doc.sections[0].dissents![0].value = 'Try `npm run check`.'
    await act(async () => root.render(<ConceptDetail concept={doc} />))
    expect(container.querySelector('strong')?.textContent).toBeTruthy()
    expect(container.querySelector('li')?.textContent).toBe('Check sources')
    expect(container.querySelector('pre code')?.textContent).toContain('npm test')
    expect(container.querySelector('script')).toBeNull()
    expect([...container.querySelectorAll('code')].some((code) => code.textContent === 'npm run check')).toBe(true)
  })

  it('bounds a 438-section document and jumps directly to evidence outside its first page', async () => {
    const doc = concept()
    doc.sections = Array.from({ length: 438 }, (_, index) => ({ ...doc.sections[0], name: `Section ${index}`, key: `s${index}`, value: index === 420 ? 'Unique migration evidence' : 'Ordinary note', dissents: [] }))
    await act(async () => root.render(<ConceptDetail concept={doc} matchQuery="migration" />))
    expect(container.querySelectorAll('.cc-concept-reader .cc-md').length).toBe(20)
    expect(container.textContent).not.toContain('Unique migration evidence')
    const jump = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Jump to matching section'))!
    await act(async () => jump.click())
    expect(container.textContent).toContain('Unique migration evidence')
    expect(container.querySelectorAll('.cc-concept-reader .cc-md').length).toBe(18)
    const collapse = container.querySelector<HTMLButtonElement>('[data-section="420"]')!
    await act(async () => collapse.click())
    expect(collapse.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('Unique migration evidence')
  })
})

it('visits every matching section in order, including matches on the same page, then wraps', async () => {
  const doc = concept()
  doc.sections = Array.from({ length: 23 }, (_, index) => ({ ...doc.sections[0], name: `Section ${index}`, key: `s${index}`, value: [0, 1, 20, 21].includes(index) ? 'Migration evidence' : 'Ordinary note', dissents: [] }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  try {
    await act(async () => root.render(<ConceptDetail concept={doc} matchQuery="migration" />))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const jump = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Jump to matching section'))!
    // Record scheduled focus after the page render, as browsers do.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    for (const index of [0, 1, 20, 21, 0]) {
      await act(async () => jump.click())
      frames.splice(0).forEach((frame) => frame(0))
      expect((focus.mock.instances[focus.mock.instances.length - 1] as HTMLElement | undefined)?.getAttribute('data-section')).toBe(String(index))
    }
    focus.mockRestore()
  } finally { vi.unstubAllGlobals() }
})
