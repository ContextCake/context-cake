import { describe, expect, it } from 'vitest'
import { ccTokens, declarationsFor, stripCssComments } from './css-blocks'
import {
  BLOCKS, DARK_SELECTOR, INHERITS_FROM_LIGHT, LIGHT_SELECTOR, NON_COLOR_TOKEN_RE, PRIMITIVES, STYLESHEET,
  canonicalColorTokens, isAllowlistedLiteral, isColorLike, isTokenBlock,
} from './gates'

// Structural gates over styles.css. The theme families PR 8 adds redeclare
// tokens, never selectors, so a palette can only work if (a) the set of color
// tokens is knowable from `:root`, (b) the dark block redeclares all of them,
// and (f) no component reaches around the tokens with a dark-only rule or a
// literal color. Letters follow the plan (Issue 3, "Gates"); (c)–(e) land with
// the families. Shared constants live in ./gates.ts.

// TODO(PR 8, gate c): each `themes/<id>.css` family block declares exactly PRIMITIVES.
// TODO(PR 8, gate d): `themes/_derived.css` covers canonical ∖ PRIMITIVES.
// TODO(PR 8, gate e): registry ids ↔ family files 1:1; both selector forms
//   (`:root[data-palette=…][data-theme=…]` and `.cc-theme-swatch[…]`) present.

/**
 * A theme-conditional component rule: `[data-theme="dark"]` followed, after
 * any further attribute selectors on the same compound, by anything other
 * than the end of that selector (`{` or `,`). Catches ` .cc-x`, `>.cc-x`,
 * `:is(.cc-x)`, `*`, and `:not([data-theme="dark"]) .cc-x` alike.
 */
const DARK_COMPONENT_RULE = /\[data-theme="dark"\](?:\[[^\]]*\])*\s*[^\s,{]/

/** Any way of writing a color literally: hex, functional, or a named color other than transparent/currentColor. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|(?<![\w-])(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink|silver|navy|teal|aqua|lime|maroon|olive|fuchsia|cyan|magenta)(?![\w-])/gi

describe('the flat block reader fits this stylesheet', () => {
  it('has no CSS nesting (a nested rule would be mis-bucketed silently)', () => {
    const source = stripCssComments(STYLESHEET)
    expect(/;[^;{}]*\{/.test(source), 'a declaration followed by a nested block').toBe(false)
    expect(BLOCKS.filter((block) => block.selector.includes(';')).map((block) => block.selector)).toEqual([])
  })

  it('finds both ContextCake token blocks', () => {
    expect(BLOCKS.some((block) => block.selectors.includes(LIGHT_SELECTOR))).toBe(true)
    expect(BLOCKS.some((block) => block.selectors.includes(DARK_SELECTOR))).toBe(true)
  })
})

describe('canonical color tokens (a)', () => {
  const light = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
  const canonical = canonicalColorTokens()

  it('reads a plausible :root block', () => {
    expect(light.size).toBeGreaterThan(40)
    expect(canonical.size).toBeGreaterThan(30)
  })

  it('every :root token is either a color or a known non-color shape', () => {
    const unexplained = [...light.entries()]
      .filter(([token, value]) => !isColorLike(value) && !NON_COLOR_TOKEN_RE.test(token))
      .map(([token, value]) => `${token}: ${value}`)
    expect(unexplained).toEqual([])
  })

  it('every family primitive is a canonical color token', () => {
    const missing = PRIMITIVES.filter((token) => !canonical.has(token))
    expect(missing).toEqual([])
  })

  it('declares the semantic role tokens components lean on', () => {
    for (const token of [
      '--cc-neutral-fill', '--cc-neutral-fill-hover',
      '--cc-solid-bg', '--cc-solid-fg',
      '--cc-cta-bg', '--cc-cta-fg',
      '--cc-ask-bg', '--cc-ask-fg', '--cc-ask-ring',
      '--cc-code-bg', '--cc-code-fg',
    ]) expect(canonical.has(token), token).toBe(true)
  })
})

describe('dark block redeclares the canonical set (b)', () => {
  const canonical = canonicalColorTokens()
  const dark = ccTokens(declarationsFor(BLOCKS, DARK_SELECTOR))

  it('declares every canonical color token not explicitly inherited', () => {
    const missing = [...canonical.keys()].filter((token) => !dark.has(token) && !INHERITS_FROM_LIGHT.has(token))
    expect(missing).toEqual([])
  })

  it('declares no token the light block does not (a dark-only token is undefined in light)', () => {
    const light = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
    const extra = [...dark.keys()].filter((token) => !light.has(token))
    expect(extra).toEqual([])
  })

  it('every dark value is color-like where the light one is', () => {
    const wrong = [...canonical.keys()].filter((token) => dark.has(token) && !isColorLike(dark.get(token) as string))
    expect(wrong).toEqual([])
  })
})

describe('components go through tokens (f)', () => {
  it('has no theme-conditional component selector', () => {
    const inLines = stripCssComments(STYLESHEET)
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => DARK_COMPONENT_RULE.test(text))
      .map(({ line, text }) => `line ${line}: ${text.trim()}`)
    // A selector wrapped across lines only shows up once whitespace is collapsed.
    const inBlocks = BLOCKS.filter((block) => DARK_COMPONENT_RULE.test(block.selector)).map((block) => `block: ${block.selector}`)
    expect([...inLines, ...inBlocks], 'extend a semantic token in both :root blocks instead of overriding a component in dark').toEqual([])
  })

  it('has no color literal outside the token blocks', () => {
    const literals: string[] = []
    for (const block of BLOCKS) {
      if (isTokenBlock(block)) continue
      for (const [prop, value] of block.declarationList) {
        for (const m of value.matchAll(COLOR_LITERAL)) {
          if (!isAllowlistedLiteral(m[0])) literals.push(`${block.selector} { ${prop}: ${value} }`)
        }
      }
    }
    expect(literals, 'write a token, or color-mix(in srgb, var(--cc-…) N%, transparent) for a tint').toEqual([])
  })

  it('every var(--cc-*) a component reads is declared in :root', () => {
    const light = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
    const undeclared = new Set<string>()
    for (const block of BLOCKS) {
      if (isTokenBlock(block)) continue
      for (const [, value] of block.declarationList) {
        for (const m of value.matchAll(/var\(\s*(--cc-[\w-]+)\s*(,|\))/g)) {
          // A reference with a fallback (`var(--cc-x, …)`) is allowed to name a token that does not exist.
          if (m[2] === ')' && !light.has(m[1])) undeclared.add(m[1])
        }
      }
    }
    expect([...undeclared].sort()).toEqual([])
  })
})
