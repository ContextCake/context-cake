import { describe, expect, it } from 'vitest'
import { destinationForView, parseHash, viewForDestination } from './shell-navigation'

describe('shell navigation contract', () => {
  it('maps every stable ViewId into one of five destinations', () => {
    expect(destinationForView('overview')).toBe('home')
    expect(destinationForView('canvas')).toBe('cascade')
    expect(destinationForView('concepts')).toBe('knowledge')
    expect(destinationForView('files')).toBe('knowledge')
    expect(destinationForView('sources')).toBe('sources')
    expect(destinationForView('triage')).toBe('review')
    expect(destinationForView('conflicts')).toBe('review')
  })

  it('restores grouped subviews without changing their routes', () => {
    expect(viewForDestination('knowledge', 'files')).toBe('files')
    expect(viewForDestination('review', 'concepts', 'conflicts')).toBe('conflicts')
    expect(viewForDestination('home')).toBe('overview')
  })

  it('preserves legacy hashes and exact concept deep links', () => {
    expect(parseHash('#/canvas')).toEqual({ view: 'canvas' })
    expect(parseHash('#/concepts/interfaces%2Fauth')).toEqual({ view: 'concepts', concept: 'interfaces/auth' })
    expect(parseHash('#/obsolete')).toEqual({})
    expect(parseHash('')).toEqual({})
  })
})
