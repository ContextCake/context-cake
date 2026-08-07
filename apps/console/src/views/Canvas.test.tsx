// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { Concept } from '../data'
import { computeLayout } from './Canvas'

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
