import { describe, expect, it } from 'vitest'
import { contrast, luminance, over, parseColor, resolveToken, type Declarations, type Rgba } from './contrast'
import { PALETTES } from './gates'

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a })
const near = (actual: Rgba, expected: Rgba, tolerance = 0.51) => {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.a - expected.a)).toBeLessThanOrEqual(0.005)
}

describe('parseColor', () => {
  it('reads the syntaxes styles.css uses', () => {
    near(parseColor('#F4F3EA') as Rgba, rgba(244, 243, 234))
    near(parseColor('#fff') as Rgba, rgba(255, 255, 255))
    near(parseColor('#0000') as Rgba, rgba(0, 0, 0, 0))
    near(parseColor('#17241f80') as Rgba, rgba(23, 36, 31, 128 / 255))
    near(parseColor('rgba(21,25,23,0.24)') as Rgba, rgba(21, 25, 23, 0.24))
    near(parseColor('rgb(21 25 23 / 50%)') as Rgba, rgba(21, 25, 23, 0.5))
    near(parseColor('rgb(10%, 20%, 30%)') as Rgba, rgba(25.5, 51, 76.5))
    near(parseColor('transparent') as Rgba, rgba(0, 0, 0, 0))
    near(parseColor(' WHITE ') as Rgba, rgba(255, 255, 255))
    near(parseColor('black') as Rgba, rgba(0, 0, 0))
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['var(--cc-page)', 'color-mix(in srgb, red, blue)', 'none', '#12', '#12345', 'rgb(1,2)', 'hsl(0 0% 0%)', 'red']) {
      expect(parseColor(bad), bad).toBeNull()
    }
  })

  it('clamps out-of-range channels so luminance stays in 0..1', () => {
    near(parseColor('rgb(300, -5, 0)') as Rgba, rgba(255, 0, 0))
    near(parseColor('rgba(0, 0, 0, 7)') as Rgba, rgba(0, 0, 0, 1))
  })
})

describe('over / luminance / contrast', () => {
  it('composites source-over', () => {
    near(over(rgba(255, 255, 255, 0.5), rgba(0, 0, 0)), rgba(127.5, 127.5, 127.5))
    near(over(rgba(255, 0, 0, 0.25), rgba(0, 0, 255, 0.5)), rgba(255 * 0.25 / 0.625, 0, 255 * 0.5 * 0.75 / 0.625, 0.625))
    near(over(rgba(9, 9, 9, 0), rgba(1, 2, 3)), rgba(1, 2, 3))
  })

  it('matches WCAG reference values', () => {
    expect(luminance(rgba(255, 255, 255))).toBeCloseTo(1, 6)
    expect(luminance(rgba(0, 0, 0))).toBeCloseTo(0, 6)
    expect(luminance(rgba(255, 0, 0))).toBeCloseTo(0.2126, 4)
    expect(contrast(rgba(0, 0, 0), rgba(255, 255, 255))).toBeCloseTo(21, 6)
    expect(contrast(rgba(255, 255, 255), rgba(0, 0, 0))).toBeCloseTo(21, 6)
    expect(contrast(rgba(119, 119, 119), rgba(255, 255, 255))).toBeCloseTo(4.48, 2)
    expect(contrast(rgba(80, 80, 80), rgba(80, 80, 80))).toBe(1)
  })
})

describe('resolveToken', () => {
  const decls: Declarations = new Map([
    ['--cc-page', '#000000'],
    ['--cc-raised', 'rgba(255,255,255,0.5)'],
    ['--cc-alias', 'var(--cc-page)'],
    ['--cc-fallback', 'var(--cc-nope, #ff0000)'],
    ['--cc-tint', 'color-mix(in srgb, var(--cc-white) 12%, transparent)'],
    ['--cc-white', '#ffffff'],
    ['--cc-half', 'color-mix(in srgb, white, black)'],
    ['--cc-weighted', 'color-mix(in srgb, #ff0000 25%, #0000ff)'],
    ['--cc-partial', 'color-mix(in srgb, #ff0000 20%, #0000ff 20%)'],
    ['--cc-loop-a', 'var(--cc-loop-b)'],
    ['--cc-loop-b', 'var(--cc-loop-a)'],
    ['--cc-not-a-color', 'none'],
  ])

  it('follows var() and var() fallbacks', () => {
    near(resolveToken('--cc-alias', decls), rgba(0, 0, 0))
    near(resolveToken('--cc-fallback', decls), rgba(255, 0, 0))
  })

  it('mixes color-mix(in srgb …) premultiplied, so "X p%, transparent" is X at p% alpha', () => {
    near(resolveToken('--cc-tint', decls), rgba(255, 255, 255, 0.12))
    near(resolveToken('--cc-half', decls), rgba(127.5, 127.5, 127.5))
    near(resolveToken('--cc-weighted', decls), rgba(63.75, 0, 191.25))
    near(resolveToken('--cc-partial', decls), rgba(127.5, 0, 127.5, 0.4))
  })

  it('composites over the backdrop chain nearest-first', () => {
    near(resolveToken('--cc-tint', decls, ['--cc-raised', '--cc-page']), rgba(0.12 * 255 + 0.88 * 127.5, 0.12 * 255 + 0.88 * 127.5, 0.12 * 255 + 0.88 * 127.5))
  })

  it('reports cycles, unknown tokens, non-colors and bad percentages instead of returning nonsense', () => {
    expect(() => resolveToken('--cc-loop-a', decls)).toThrow(/Cycle/)
    expect(() => resolveToken('--cc-missing', decls)).toThrow(/not declared/)
    expect(() => resolveToken('--cc-not-a-color', decls)).toThrow(/Cannot resolve/)
    const wild: Declarations = new Map([['--cc-x', 'color-mix(in srgb, #ff0000 150%, #00ff00)']])
    expect(() => resolveToken('--cc-x', wild)).toThrow(/out of range/)
  })
})

// ---------------------------------------------------------------------------
// The gate. One `it` per (palette, mode), over PALETTES in ./gates.ts —
// ContextCake plus every family under src/themes/. A new family is scored
// here without touching this file, and there is no per-family exception list.

interface Check { fg: string; bg: string; backdrop?: string[]; min: number }

/** Every pair the console's readability rests on. `backdrop` is what `bg` itself sits on when it is translucent. */
const CHECKS: Check[] = [
  { fg: '--cc-ink', bg: '--cc-page', min: 4.5 },
  { fg: '--cc-ink', bg: '--cc-surface', backdrop: ['--cc-page'], min: 4.5 },
  { fg: '--cc-ink', bg: '--cc-raised', backdrop: ['--cc-page'], min: 4.5 },
  { fg: '--cc-body', bg: '--cc-page', min: 4.5 },
  { fg: '--cc-body', bg: '--cc-surface', backdrop: ['--cc-page'], min: 4.5 },
  { fg: '--cc-body', bg: '--cc-raised', backdrop: ['--cc-page'], min: 4.5 },
  { fg: '--cc-caption', bg: '--cc-page', min: 3 },
  { fg: '--cc-caption', bg: '--cc-surface', backdrop: ['--cc-page'], min: 3 },
  { fg: '--cc-caption', bg: '--cc-raised', backdrop: ['--cc-page'], min: 3 },
  { fg: '--cc-blue-text', bg: '--cc-blue-fill', backdrop: ['--cc-raised', '--cc-page'], min: 4.5 },
  { fg: '--cc-teal-text', bg: '--cc-teal-fill', backdrop: ['--cc-raised', '--cc-page'], min: 4.5 },
  { fg: '--cc-amber-text', bg: '--cc-amber-fill', backdrop: ['--cc-raised', '--cc-page'], min: 4.5 },
  { fg: '--cc-on-teal', bg: '--cc-teal-stroke-e', min: 3 },
  { fg: '--cc-solid-fg', bg: '--cc-solid-bg', min: 4.5 },
  { fg: '--cc-code-fg', bg: '--cc-code-bg', min: 4.5 },
  { fg: '--cc-cta-fg', bg: '--cc-cta-bg', backdrop: ['--cc-raised', '--cc-page'], min: 3 },
  { fg: '--cc-ask-fg', bg: '--cc-ask-bg', backdrop: ['--cc-header-bg', '--cc-page'], min: 4.5 },
]

describe('contrast gate', () => {
  for (const { palette, mode, decls } of PALETTES) {
    it(`${palette} ${mode}: every reading pair clears its WCAG floor`, () => {
      const failures: string[] = []
      for (const { fg, bg, backdrop = [], min } of CHECKS) {
        const chain = [bg, ...backdrop]
        const background = resolveToken(bg, decls, backdrop)
        // A translucent stack (a family whose page is not opaque) would make the
        // ratio meaningless; fail loudly rather than score against nothing.
        if (background.a < 1) failures.push(`${bg} over ${backdrop.join(' → ') || 'nothing'} is still translucent (alpha ${background.a.toFixed(2)})`)
        const foreground = resolveToken(fg, decls, chain)
        const ratio = contrast(foreground, background)
        if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`)
      }
      expect(failures).toEqual([])
    })
  }
})
