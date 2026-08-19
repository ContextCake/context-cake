import { describe, expect, it } from 'vitest'
import { ccTokens, declarationsFor, parseCssBlocks, stripCssComments } from './css-blocks'
import {
  BLOCKS, DARK_SELECTOR, DERIVED_BLOCKS, DERIVED_DARK_SELECTOR, DERIVED_SELECTOR, DERIVED_STYLESHEET,
  DERIVED_SWATCH_DARK_SELECTOR, DERIVED_SWATCH_SELECTOR, FAMILY_FILES, INHERITS_FROM_LIGHT, LIGHT_SELECTOR,
  NON_COLOR_TOKEN_RE, PRIMITIVES, STYLESHEET, TOKEN_BLOCK_SELECTOR_RE,
  canonicalColorTokens, familySelector, isAllowlistedLiteral, isColorLike, isTokenBlock, swatchSelector,
} from './gates'
import { DEFAULT_PALETTE, PALETTES as FAMILIES, PALETTE_IDS, isPaletteId } from './registry'
import INDEX_CSS from './index.css?raw'

// Structural gates over styles.css and src/themes/. A theme family redeclares
// tokens, never selectors, so a palette can only work if (a) the set of color
// tokens is knowable from `:root`, (b) the dark block redeclares all of them,
// (c) every family block declares exactly the primitives, (d) `_derived.css`
// computes everything else, (e) the registry and the files agree, and (f) no
// component reaches around the tokens with a dark-only rule or a literal
// color. Letters follow the plan (Issue 3, "Gates"). Shared constants live in
// ./gates.ts.

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

// ---------------------------------------------------------------------------
// Theme families

/** The families a file exists for, other than ContextCake (which lives in styles.css). */
const THIRD_PARTY = FAMILIES.filter((family) => family.id !== DEFAULT_PALETTE)

/**
 * What a `_derived.css` value may be: a token reference, `transparent`,
 * `none`, or a `color-mix()` (nested one level, optionally as the color of a
 * shadow), whose leaves are tokens, `transparent`, `black` or `white`. Any
 * other word — a hex, a named color, an rgb() — is a palette choice and
 * belongs in a family file, not here.
 */
const DERIVED_VALUE_RE = /^(?:var\(--cc-[\w-]+\)|transparent|none|(?:0 \d+px \d+px )?color-mix\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))$/
const DERIVED_LEAF_RE = /(?<=^|[\s,(])-{0,2}[a-z#][\w#-]*/g
const DERIVED_LEAF_ALLOWED = new Set(['in', 'srgb', 'transparent', 'none', 'black', 'white', 'color-mix', 'var'])

describe('family blocks declare every primitive and only canonical tokens (c)', () => {
  const canonical = canonicalColorTokens()

  for (const family of THIRD_PARTY) {
    const css = FAMILY_FILES.get(family.id)
    it(`${family.id}: has a file`, () => {
      expect(css, `src/themes/${family.id}.css`).toBeDefined()
    })
    if (css === undefined) continue
    const blocks = parseCssBlocks(css)

    for (const mode of ['light', 'dark'] as const) {
      const selector = familySelector(family.id, mode)
      it(`${family.id} ${mode}: declares every primitive, plus color-scheme`, () => {
        const decls = declarationsFor(blocks, selector)
        expect(decls.size, `block ${selector} not found`).toBeGreaterThan(0)
        const missing = PRIMITIVES.filter((token) => !decls.has(token))
        expect(missing).toEqual([])
        expect(decls.get('color-scheme')).toBe(mode)
      })

      it(`${family.id} ${mode}: declares only canonical tokens, all color-like`, () => {
        const decls = declarationsFor(blocks, selector)
        const unknown = [...decls.keys()].filter((prop) => prop !== 'color-scheme' && !canonical.has(prop))
        expect(unknown, 'a family may override a derived token, but only one :root declares').toEqual([])
        const notColor = [...ccTokens(decls).entries()].filter(([, value]) => !isColorLike(value)).map(([token]) => token)
        expect(notColor).toEqual([])
      })

      it(`${family.id} ${mode}: is declared for the root and for a picker swatch, in one rule`, () => {
        const block = blocks.find((candidate) => candidate.selectors.includes(selector))
        expect(block?.selectors, `${selector} must also list ${swatchSelector(family.id, mode)}`).toContain(swatchSelector(family.id, mode))
      })
    }

    it(`${family.id}: contains nothing but its two token blocks`, () => {
      const others = blocks.filter((block) => !block.selectors.every((selector) => TOKEN_BLOCK_SELECTOR_RE.test(selector)))
      expect(others.map((block) => block.selector), 'component rules do not belong in a family file').toEqual([])
      expect(blocks).toHaveLength(2)
    })
  }
})

describe('_derived.css covers everything a family does not declare (d)', () => {
  const canonical = canonicalColorTokens()
  const derivedLight = ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_SELECTOR))
  const derivedDark = ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_DARK_SELECTOR))

  it('declares every canonical color token that is not a primitive', () => {
    const missing = [...canonical.keys()].filter((token) => !PRIMITIVES.includes(token) && !derivedLight.has(token))
    expect(missing).toEqual([])
  })

  it('declares no primitive (a family owns those) and no token :root does not know', () => {
    const light = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
    for (const [label, decls] of [['light', derivedLight], ['dark', derivedDark]] as const) {
      const primitives = [...decls.keys()].filter((token) => PRIMITIVES.includes(token))
      expect(primitives, `${label}: primitives in _derived.css`).toEqual([])
      const unknown = [...decls.keys()].filter((token) => !light.has(token))
      expect(unknown, `${label}: tokens :root does not declare`).toEqual([])
    }
  })

  it('the dark half only refines tokens the light half declares', () => {
    const extra = [...derivedDark.keys()].filter((token) => !derivedLight.has(token))
    expect(extra).toEqual([])
  })

  it('redeclares everything ContextCake\'s dark block does, color or not', () => {
    // The dark block is palette-scoped, so it does not reach a family — which
    // means a token it declares that neither a family nor the derived block
    // redeclares (a shadow, say) would fall back to :root's LIGHT value in a
    // family's dark mode.
    const dark = ccTokens(declarationsFor(BLOCKS, DARK_SELECTOR))
    const leaking = [...dark.keys()].filter((token) => !PRIMITIVES.includes(token) && !derivedLight.has(token))
    expect(leaking).toEqual([])
  })

  it('declares the same tokens on a swatch as on the root', () => {
    expect([...ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_SWATCH_SELECTOR)).keys()].sort()).toEqual([...derivedLight.keys()].sort())
    expect([...ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_SWATCH_DARK_SELECTOR)).keys()].sort()).toEqual([...derivedDark.keys()].sort())
  })

  it('every value is built from tokens, transparent, black or white — no palette color of its own', () => {
    const offenders: string[] = []
    for (const block of DERIVED_BLOCKS) {
      for (const [prop, value] of block.declarationList) {
        if (!prop.startsWith('--cc-')) continue
        if (!DERIVED_VALUE_RE.test(value)) { offenders.push(`${prop}: ${value}`); continue }
        for (const m of value.matchAll(DERIVED_LEAF_RE)) {
          const leaf = m[0]
          if (leaf.startsWith('--cc-') || DERIVED_LEAF_ALLOWED.has(leaf)) continue
          offenders.push(`${prop}: ${value} (${leaf})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('carries only token blocks and the one sidebar rule', () => {
    const componentRules = DERIVED_BLOCKS
      .filter((block) => block.declarationList.some(([prop]) => !prop.startsWith('--cc-')))
      .map((block) => block.selector)
    expect(componentRules).toEqual([':root[data-palette]:where(:not([data-palette="contextcake"])) .cc-sidebar'])
    expect(DERIVED_STYLESHEET).toMatch(/backdrop-filter: none/)
  })
})

describe('registry and files agree (e)', () => {
  it('lists ContextCake first as the default and every id as a valid slug', () => {
    expect(PALETTE_IDS[0]).toBe(DEFAULT_PALETTE)
    expect(new Set(PALETTE_IDS).size).toBe(PALETTE_IDS.length)
    for (const id of PALETTE_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
    expect(isPaletteId('contextcake')).toBe(true)
    expect(isPaletteId('Solarized')).toBe(false)
    expect(isPaletteId(undefined)).toBe(false)
  })

  it('has one CSS file per registered family and no file without a registry entry', () => {
    const files = [...FAMILY_FILES.keys()].sort()
    const ids = THIRD_PARTY.map((family) => family.id).sort()
    expect(files).toEqual(ids)
  })

  it('ships only families with both an official light and a dark variant, each with attribution', () => {
    for (const family of THIRD_PARTY) {
      expect(family.variants.light, family.id).toBeTruthy()
      expect(family.variants.dark, family.id).toBeTruthy()
      expect(family.attribution?.license, family.id).toBe('MIT')
      expect(family.attribution?.url, family.id).toMatch(/^https:\/\//)
    }
    expect(FAMILIES.find((family) => family.id === DEFAULT_PALETTE)?.attribution).toBeNull()
  })

  it('every family file names its source URL and license in its header comment', () => {
    for (const [id, css] of FAMILY_FILES) {
      const header = css.slice(0, css.indexOf('*/'))
      expect(header, `${id}: header must cite the palette URL`).toMatch(/https?:\/\//)
      expect(header, `${id}: header must state the license`).toMatch(/License: MIT/)
    }
  })

  it('index.css imports the derived block and every family', () => {
    // The glob in gates.ts finds a family file whether or not it is imported;
    // a registered family whose file is not imported would pass every gate and
    // then render as ContextCake primitives under a family's derived tokens.
    const imports = [...INDEX_CSS.matchAll(/@import\s+'\.\/([\w-]+)\.css'/g)].map((m) => m[1])
    expect(imports).toContain('_derived')
    expect(imports.filter((id) => id !== '_derived').sort()).toEqual(THIRD_PARTY.map((family) => family.id).sort())
  })

  it("ContextCake's dark block is scoped to its own palette, so families never compete with it", () => {
    // Structural, not an import-order proxy: at (0,2,0) the derived block and
    // an unscoped `:root[data-theme="dark"]` would tie on specificity and be
    // decided by bundle order. Scoping the dark block to `contextcake` (or to
    // a root with no data-palette yet — the pre-paint instant) removes the tie.
    const dark = BLOCKS.find((block) => block.selectors.includes(DARK_SELECTOR))
    expect(dark, DARK_SELECTOR).toBeDefined()
    expect(DARK_SELECTOR).toMatch(/^:root:where\(\[data-palette="contextcake"\], :not\(\[data-palette\]\)\)\[data-theme="dark"\]$/)
    // And no other block re-declares tokens on a bare dark root.
    const bare = BLOCKS.filter((block) => block.selectors.includes(':root[data-theme="dark"]'))
    expect(bare.map((block) => block.selector)).toEqual([])
  })

  it('a bare .cc-theme-swatch layout rule is a component rule, not a token block', () => {
    expect(TOKEN_BLOCK_SELECTOR_RE.test('.cc-theme-swatch')).toBe(false)
    expect(TOKEN_BLOCK_SELECTOR_RE.test(swatchSelector('solarized', 'light'))).toBe(true)
    expect(TOKEN_BLOCK_SELECTOR_RE.test(':root')).toBe(true)
    expect(TOKEN_BLOCK_SELECTOR_RE.test(':root[data-theme="dark"]')).toBe(true)
  })

  it('ContextCake itself is declared for a picker swatch in styles.css', () => {
    expect(BLOCKS.some((block) => block.selectors.includes(LIGHT_SELECTOR) && block.selectors.includes(swatchSelector(DEFAULT_PALETTE, 'light')))).toBe(true)
    expect(BLOCKS.some((block) => block.selectors.includes(DARK_SELECTOR) && block.selectors.includes(swatchSelector(DEFAULT_PALETTE, 'dark')))).toBe(true)
  })
})
