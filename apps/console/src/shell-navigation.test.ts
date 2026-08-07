import { describe, expect, it } from 'vitest'
import { destinationForView, filesHash, parseHash, viewForDestination } from './shell-navigation'

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

describe('files deep links', () => {
  it('round-trips scope and file through the hash', () => {
    const cases: [string | null, string | null][] = [
      [null, null],
      ['vault', null],
      ['vault', 'vault/Daily Notes/2024-01-05.md'],
      ['my vault', 'my vault/a/b/c/deep note.md'],
      // A file from another source is not addressable while unscoped, so the
      // hash carries the scope alone — and parsing it back agrees.
      ['vault', 'other/x.md'],
    ]
    for (const [layer, file] of cases) {
      const hash = filesHash(layer, file)
      const parsed = parseHash(hash)
      expect(filesHash(parsed.layer ?? null, parsed.file ?? null)).toBe(hash)
      expect(parsed.layer ?? null).toBe(layer)
    }
  })

  it('serializes the two shapes the navigator can be in', () => {
    expect(filesHash(null)).toBe('#/files')
    expect(filesHash('vault')).toBe('#/files/vault')
    expect(filesHash('vault', 'vault/notes/a.md')).toBe('#/files/vault/notes%2Fa.md')
    // A file outside the scope cannot be named by this route; the scope wins.
    expect(filesHash('vault', 'other/a.md')).toBe('#/files/vault')
  })

  it('parses a files link into the state the view restores', () => {
    expect(parseHash('#/files')).toEqual({ view: 'files' })
    expect(parseHash('#/files/vault')).toEqual({ view: 'files', layer: 'vault' })
    expect(parseHash('#/files/my%20vault/Daily%20Notes%2F2024-01-05.md'))
      .toEqual({ view: 'files', layer: 'my vault', file: 'my vault/Daily Notes/2024-01-05.md' })
    // A malformed escape must not throw the whole shell into the error state.
    expect(parseHash('#/files/%E0%A4%A')).toEqual({ view: 'files' })
  })
})
