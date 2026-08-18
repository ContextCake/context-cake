// Shared fixtures and constants for the theme gate suites (`tokens.test.ts`,
// `contrast.test.ts`, `../theme.test.ts`). Not application code — it lives
// beside the tests so a later suite can import a constant without importing a
// test file (which would re-register that file's `describe`s). PR 8 extends
// PALETTES, PRIMITIVES and TOKEN_BLOCK_SELECTOR_RE here; the suites read them.
//
// The stylesheet arrives as a Vite raw import rather than through node:fs —
// the console has no @types/node (it is a browser package) and this keeps it
// that way; vitest.config.ts lets `.css?raw` through its CSS blanking.
import STYLES from '../styles.css?raw'
import { parseColor, type Declarations, type Rgba } from './contrast'
import { ccTokens, declarationsFor, parseCssBlocks, type CssBlock } from './css-blocks'

export const STYLESHEET: string = STYLES
export const BLOCKS: readonly CssBlock[] = parseCssBlocks(STYLES)

export const LIGHT_SELECTOR = ':root'
export const DARK_SELECTOR = ':root[data-theme="dark"]'

/**
 * A block is a token block — allowed to carry literal colors — when one of its
 * selectors is `:root`, the dark `:root`, or (PR 8) a palette family block on
 * `:root` / `.cc-theme-swatch` keyed by `data-palette` and `data-theme`.
 */
export const TOKEN_BLOCK_SELECTOR_RE = /^(?::root|\.cc-theme-swatch)(?:\[data-(?:theme|palette)="[a-z][a-z0-9-]*"\])*$/

export function isTokenBlock(block: CssBlock): boolean {
  return block.selectors.some((selector) => TOKEN_BLOCK_SELECTOR_RE.test(selector))
}

/**
 * `--cc-*` tokens in `:root` that are not colors, matched by shape. Anything
 * in `:root` that is neither color-like nor one of these fails the suite, so a
 * mistyped color token cannot quietly fall out of the canonical set.
 */
export const NON_COLOR_TOKEN_RE = /^--cc-(radius-[a-z]+|z-[a-z-]+|ease-out|[a-z-]*-height|space|panel-padding|panel-shadow|soft-shadow)$/

/**
 * Canonical color tokens the dark block is allowed to leave to the light
 * value. Empty on purpose: every color the light block names, the dark block
 * names too, so a family author can copy the dark block as a checklist.
 */
export const INHERITS_FROM_LIGHT: ReadonlySet<string> = new Set()

/**
 * Literal colors permitted in component rules (outside token blocks). Pure
 * black or white shadow colors would be the only sensible entries — they are
 * the same in every palette — and after the tokenization pass there are none,
 * so the list is empty and any literal fails. Add to it only for a
 * black/white shadow; entries are compared as parsed colors, not text.
 */
export const LITERAL_ALLOWLIST: readonly string[] = []

export function isAllowlistedLiteral(literal: string): boolean {
  const color = parseColor(literal)
  if (!color) return false
  return LITERAL_ALLOWLIST.some((allowed) => sameColor(parseColor(allowed), color))
}

function sameColor(a: Rgba | null, b: Rgba): boolean {
  return a !== null && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

/**
 * The tokens a theme family declares per mode; `themes/_derived.css` (PR 8)
 * computes every other canonical color from these. Families also set
 * `color-scheme`, which is not a `--cc-*` token and so is not listed.
 */
export const PRIMITIVES: readonly string[] = [
  '--cc-page', '--cc-surface', '--cc-raised', '--cc-header-bg', '--cc-canvas-bg',
  '--cc-ink', '--cc-body', '--cc-caption', '--cc-faint',
  '--cc-layer-company', '--cc-layer-team', '--cc-layer-personal', '--cc-conflict',
]

/** A value that reads as a color: a literal, a `var(--cc-…)` reference, or a `color-mix()`. */
export function isColorLike(value: string): boolean {
  return parseColor(value) !== null || /^var\(--cc-/.test(value) || /^color-mix\(/.test(value)
}

/** Every `--cc-*` in `:root` whose value is color-like — the set a palette must cover. */
export function canonicalColorTokens(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [token, value] of ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))) {
    if (isColorLike(value)) out.set(token, value)
  }
  return out
}

export interface PaletteMode { palette: string; mode: 'light' | 'dark'; decls: Declarations }

/** ContextCake's two modes: dark is the light block overlaid with the dark block, as the cascade sees it. */
export function contextCakeModes(): PaletteMode[] {
  const light = ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR))
  const dark = new Map(light)
  for (const [token, value] of ccTokens(declarationsFor(BLOCKS, DARK_SELECTOR))) dark.set(token, value)
  return [
    { palette: 'contextcake', mode: 'light', decls: light },
    { palette: 'contextcake', mode: 'dark', decls: dark },
  ]
}

/** Every (palette, mode) the contrast gate scores. PR 8 appends its families. */
export const PALETTES: readonly PaletteMode[] = [...contextCakeModes()]
