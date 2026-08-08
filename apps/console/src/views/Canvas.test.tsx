// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Concept } from '../data'
import { capConceptsPerLane, clampZoom, computeFitScale, computeLayout } from './Canvas'

function concept(id: string, layer: Concept['layers'][number], dissent?: Concept['layers'][number]): Concept {
  return {
    id,
    title: id,
    type: 'note',
    layers: dissent ? [layer, dissent] : [layer],
    sections: [{
      name: 'summary',
      winner: layer,
      sourceLayer: layer,
      value: id,
      dissents: dissent ? [{ layer: dissent, sourceLayer: dissent, value: `${id}-dissent` }] : undefined,
    }],
  }
}

describe('computeLayout', () => {
  it('reuses columns across non-overlapping lanes while reserving dissent lanes', () => {
    const layout = computeLayout([
      concept('personal-with-company-dissent', 'personal', 'company'),
      concept('team-a', 'team'),
      concept('team-b', 'team'),
      concept('company-b', 'company'),
    ])
    const positions = Object.fromEntries(layout.nodes.map((node) => [node.c.id, node.x]))

    expect(positions['team-a']).toBe(positions['personal-with-company-dissent'])
    expect(positions['team-b']).not.toBe(positions['team-a'])
    expect(positions['company-b']).toBe(positions['team-b'])
    expect(layout.ghosts[0]?.x).toBe(positions['personal-with-company-dissent'] + 9)
  })
})

describe('computeFitScale', () => {
  // The old floor (Math.max(0.2, ...)) overrode content-driven fit: a huge
  // cascade needing a scale well under 0.2 to actually fit got clamped up to
  // 0.2 anyway, so "Fit" stopped fitting. The floor is now a near-zero
  // epsilon that only keeps the transform off exactly zero.
  it('reaches a scale well below the old 0.2 floor for a huge world', () => {
    const result = computeFitScale(2000, 1200, 200_000, 100_000)
    expect(result).not.toBeNull()
    expect(result!.scale).toBeLessThan(0.2)
    expect(result!.scale).toBeGreaterThan(0)
    expect(result!.scale).toBeCloseTo((2000 - 48) / 200_000, 5)
  })

  it('still guards a not-yet-laid-out element', () => {
    expect(computeFitScale(0, 0, 1000, 1000)).toBeNull()
  })
})

describe('clampZoom', () => {
  // The manual zoom/wheel clamp used to floor at 0.4, so zooming out after a
  // Fit that landed below 0.4 snapped the view back up — the opposite of
  // "zoom out". It now shares computeFitScale's epsilon floor.
  it('allows a scale well below the old 0.4 floor', () => {
    expect(clampZoom(0.05)).toBeCloseTo(0.05, 5)
  })

  it('still clamps at the top end', () => {
    expect(clampZoom(50)).toBe(2)
  })
})

describe('capConceptsPerLane', () => {
  function many(layer: Concept['layers'][number], count: number): Concept[] {
    return Array.from({ length: count }, (_, i) => concept(`${layer}-${i}`, layer))
  }

  it('passes a small cascade through unchanged', () => {
    const input = [...many('personal', 3), ...many('team', 2)]
    const result = capConceptsPerLane(input, 250)
    expect(result.shown).toBe(5)
    expect(result.total).toBe(5)
    expect(result.concepts).toHaveLength(5)
  })

  it('slices each lane independently and reports per-lane + total counts', () => {
    const input = [...many('personal', 400), ...many('team', 10), ...many('company', 5)]
    const result = capConceptsPerLane(input, 250)
    expect(result.laneCounts.personal).toEqual({ shown: 250, total: 400 })
    expect(result.laneCounts.team).toEqual({ shown: 10, total: 10 })
    expect(result.laneCounts.company).toEqual({ shown: 5, total: 5 })
    expect(result.shown).toBe(250 + 10 + 5)
    expect(result.total).toBe(415)
    expect(result.concepts).toHaveLength(result.shown)
  })

  it('keeps the first N in incoming order (no cheap per-concept date to sort by)', () => {
    const input = many('personal', 5)
    const result = capConceptsPerLane(input, 3)
    expect(result.concepts.map((c) => c.id)).toEqual(['personal-0', 'personal-1', 'personal-2'])
  })
})

describe('lane header honesty (F3)', () => {
  // vi.doMock (not vi.mock) so this stays scoped to a resetModules() import —
  // the legend test below needs the real StoreProvider, and a file-level mock
  // of '../store' would break it.
  afterEach(() => {
    vi.doUnmock('../store')
    vi.resetModules()
  })

  it('names the real source and level behind a lane instead of the static trio', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.resetModules()
    vi.doMock('../store', () => {
      const noop = () => {}
      const state = {
        mode: 'live', concepts: [], conflicts: [], sources: [{ name: 'messy-vault', layer: 'team', level: 1 }],
        setSelConcept: noop, setSelConflict: noop, setView: noop,
      }
      const useState = () => state
      return { useStore: useState, useStoreData: useState, useStoreNav: useState, useStoreInput: useState }
    })
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Canvas } = await import('./Canvas')

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<Canvas />))

    expect(container.textContent).toContain('messy-vault')
    // The team lane's round badge shows the real level (1), not the static 2 —
    // and the lane's static "runbooks, decisions, system docs" blurb is gone,
    // replaced by the source name.
    expect(container.textContent).not.toContain('runbooks, decisions, system docs')

    await act(async () => root.unmount())
    container.remove()
  })
})

describe('the canvas legend', () => {
  it('stays translucent, because the graph moves underneath it', async () => {
    // Not a style preference: the legend is absolutely positioned over the
    // pan/zoom viewport, so nodes and conflict edges slide behind it while the
    // user drags. It was once flattened to an opaque surface in a pass that
    // removed blur from four chrome selectors "for the same reason (nothing
    // behind it)" — true of those four, false of this one, and the four turned
    // out to render nowhere at all. Users who want the glass gone have the
    // reduce-transparency preference, which kills backdrop-filter app-wide.
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Canvas } = await import('./Canvas')
    const { StoreProvider } = await import('../store')

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<StoreProvider><Canvas /></StoreProvider>))

    const legend = Array.from(container.querySelectorAll('div'))
      .find((node) => node.firstElementChild?.textContent === 'The cascade — higher lanes win')
    expect(legend, 'legend not found — its caption changed, so this guard is blind').toBeTruthy()
    expect(legend!.style.getPropertyValue('backdrop-filter')).toBe('blur(10px)')
    // An opaque background would make the blur pointless even if it survived.
    expect(legend!.style.getPropertyValue('background')).toBe('var(--cc-header-bg)')

    await act(async () => root.unmount())
    container.remove()
  })
})
