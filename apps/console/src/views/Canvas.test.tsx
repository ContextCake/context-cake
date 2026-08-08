// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Concept } from '../data'
import { capConceptsPerLane, clampZoom, computeFitScale, computeLayout, countByLane, MAX_NODES_PER_LANE, MIN_SCALE } from './Canvas'

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
  // Fit and manual zoom used to have different floors (Fit ~0, manual 0.1):
  // on a large cascade Fit would land far below what manual zoom could ever
  // reach, so the first wheel notch after a Fit snapped the view back up —
  // see "Fit and manual zoom share one floor" below for the exact repro this
  // replaces. Fit and manual zoom now share MIN_SCALE, so a world too big to
  // fit at that floor is *cropped*, not shrunk arbitrarily small.
  it('floors at the shared MIN_SCALE for a world too large to fit otherwise', () => {
    const result = computeFitScale(2000, 1200, 200_000, 100_000)
    expect(result).not.toBeNull()
    expect(result!.scale).toBe(MIN_SCALE)
  })

  it('still guards a not-yet-laid-out element', () => {
    expect(computeFitScale(0, 0, 1000, 1000)).toBeNull()
  })

  // The cap (MAX_NODES_PER_LANE) is sized precisely so this never has to
  // happen for real content — see the arithmetic in Canvas.tsx — but a
  // shrunk viewport can still push a fully-saturated lane under the floor,
  // and computeFitScale must degrade to "cropped" rather than "sub-pixel"
  // when it does.
  it('crops rather than shrinking arbitrarily small when even the floor cannot fit', () => {
    const result = computeFitScale(600, 400, 200_000, 100_000)
    expect(result).not.toBeNull()
    expect(result!.scale).toBe(MIN_SCALE)
  })
})

describe('clampZoom', () => {
  it('floors a manual zoom at the shared MIN_SCALE', () => {
    expect(clampZoom(0.05)).toBe(MIN_SCALE)
    expect(clampZoom(0.001)).toBe(MIN_SCALE)
  })

  it('leaves a scale above the floor untouched', () => {
    expect(clampZoom(0.3)).toBeCloseTo(0.3, 5)
  })

  it('still clamps at the top end', () => {
    expect(clampZoom(50)).toBe(2)
  })
})

describe('Fit and manual zoom share one floor (regression)', () => {
  // This is the bug two adversarial reviewers independently confirmed on the
  // branch: FIT_MIN_SCALE (~0) and MIN_MANUAL_SCALE (0.1) disagreed, so a Fit
  // on a large cascade (3,000 concepts capped to 750 under the old
  // MAX_NODES_PER_LANE=250, on a 1440x800 canvas) landed at scale 0.02296 —
  // sub-pixel cards, a blank-looking canvas — and the very next wheel notch,
  // in EITHER direction, clamped up to 0.1: zooming OUT magnified the view
  // 4.4x under the cursor. The commit that introduced the split floor also
  // deleted the test that had pinned "zoom out must not zoom in"; this
  // restores that guarantee against the new shared floor instead.
  it('a Fit that would drop below the shared floor gets floored there, and the next zoom-out does not jump', () => {
    // Reconstructs the exact regression's inputs: a single lane fully
    // saturated at the OLD per-lane cap (250), via the real layout code
    // rather than a hand-derived worldW, so this stays honest if NODE_W/GAP_X
    // ever change.
    const saturated = Array.from({ length: 250 }, (_, i) => concept(`personal-${i}`, 'personal'))
    const { worldW, worldH } = computeLayout(saturated)

    const fit = computeFitScale(1440, 800, worldW, worldH)!
    expect(fit).not.toBeNull()
    expect(fit.scale).toBe(MIN_SCALE) // floored, not sub-pixel

    // The zoom() handler's "zoom out" factor (1/1.2) applied to the just-fitted
    // scale, then run through the same clamp a wheel-out or the − button uses.
    const zoomedOut = clampZoom(fit.scale * (1 / 1.2))
    expect(zoomedOut).toBe(fit.scale) // floored again, at the SAME value — no jump
  })

  // The cap this branch ships with (MAX_NODES_PER_LANE) is chosen so this
  // scenario above cannot actually occur for content the app renders: a
  // fully-saturated lane fits comfortably above the floor on a normal
  // desktop viewport, so Fit never needs flooring and the first zoom action
  // after it is a plain, un-clamped zoom.
  it('a fully-saturated lane at the current cap fits above the floor on a normal desktop viewport', () => {
    const saturated = Array.from({ length: MAX_NODES_PER_LANE }, (_, i) => concept(`personal-${i}`, 'personal'))
    const { worldW, worldH } = computeLayout(saturated)

    for (const width of [1280, 1440]) {
      const fit = computeFitScale(width, 800, worldW, worldH)!
      expect(fit.scale).toBeGreaterThan(MIN_SCALE)
    }
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

  it('defaults to MAX_NODES_PER_LANE when no max is given', () => {
    const input = many('personal', MAX_NODES_PER_LANE + 5)
    const result = capConceptsPerLane(input)
    expect(result.laneCounts.personal).toEqual({ shown: MAX_NODES_PER_LANE, total: MAX_NODES_PER_LANE + 5 })
  })

  it('does not crash on a concept with an empty layers array', () => {
    // primaryLayer(c) is undefined for `layers: []` (sort()[0] of an empty
    // array), so indexing straight into the byLane record and calling .push
    // on the result used to throw and unmount the whole Cascade view.
    const orphan: Concept = { ...concept('orphan', 'personal'), layers: [] }
    let result: ReturnType<typeof capConceptsPerLane> | undefined
    expect(() => { result = capConceptsPerLane([orphan]) }).not.toThrow()
    expect(result!.concepts.map((c) => c.id)).toEqual(['orphan'])
    expect(result!.laneCounts.company).toEqual({ shown: 1, total: 1 })
  })
})

describe('countByLane', () => {
  it('counts each concept into its primary lane', () => {
    const input = [
      concept('p1', 'personal'), concept('p2', 'personal'),
      concept('t1', 'team'),
      concept('c1', 'company'),
    ]
    expect(countByLane(input)).toEqual({ personal: 2, team: 1, company: 1 })
  })

  // F7: capConceptsPerLane falls back a layerless concept (empty `layers`
  // array — primaryLayer(c) is undefined there) into the company lane's
  // rendered cards. Before this fix, this count used `counts[primaryLayer(c)]
  // += 1` directly, which wrote a stray "undefined" key and left company's
  // header total not counting a concept that nonetheless occupied one of its
  // rendered slots — so the header undercounted what was actually on screen.
  it('falls back a layerless concept to company, matching capConceptsPerLane\'s rendering fallback', () => {
    const orphan: Concept = { ...concept('orphan', 'personal'), layers: [] }
    const counts = countByLane([orphan, concept('c1', 'company')])
    expect(counts).toEqual({ personal: 0, team: 0, company: 2 })
    expect(Object.keys(counts)).not.toContain('undefined')
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
