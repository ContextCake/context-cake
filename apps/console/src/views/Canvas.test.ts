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
      value: id,
      dissents: dissent ? [{ layer: dissent, value: `${id}-dissent` }] : undefined,
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
