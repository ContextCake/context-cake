// Shared fixtures and constants for the theme gate suites (`tokens.test.ts`,
// `contrast.test.ts`, `../theme.test.ts`). Not application code — it lives
// beside the tests so a later suite can import a constant without importing a
// test file (which would re-register that file's `describe`s).
//
// The stylesheets arrive as Vite raw imports rather than through node:fs —
// the console has no @types/node (it is a browser package) and this keeps it
// that way; vitest.config.ts lets `.css?raw` through its CSS blanking.
import STYLES from '../styles.css?raw'
import DERIVED from './_derived.css?raw'
import { parseColor, type Declarations, type Rgba } from './contrast'
import { ccTokens, declarationsFor, parseCssBlocks, type CssBlock } from './css-blocks'
import { PALETTES as FAMILIES, type PaletteId } from './registry'

export const STYLESHEET: string = STYLES
export const BLOCKS: readonly CssBlock[] = parseCssBlocks(STYLES)

export const LIGHT_SELECTOR = ':root'
/** ContextCake's dark block: palette-scoped, so a theme family never competes with it (see styles.css). */
export const DARK_SELECTOR = ':root:where([data-palette="contextcake"], :not([data-palette]))[data-theme="dark"]'

/**
 * Every `themes/<id>.css` family file, keyed by id, read as text. Vite's
 * glob is eager so a missing file is simply absent from the map — which is
 * what lets `tokens.test.ts` (gate e) diff the registry against the disk.
 * `_derived.css` and `index.css` are excluded by the leading-underscore /
 * name test below rather than by a glob negation, so a new family file is
 * picked up without touching this list.
 */
const FAMILY_SOURCES = import.meta.glob('./*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
export const FAMILY_FILES: ReadonlyMap<string, string> = new Map(
  Object.entries(FAMILY_SOURCES)
    .map(([path, css]) => [path.replace(/^\.\//, '').replace(/\.css$/, ''), css] as [string, string])
    .filter(([id]) => !id.startsWith('_') && id !== 'index'),
)

export const DERIVED_STYLESHEET: string = DERIVED
export const DERIVED_BLOCKS: readonly CssBlock[] = parseCssBlocks(DERIVED)

/** The `_derived.css` selectors: everything but ContextCake, on the root and on a swatch. */
export const DERIVED_SELECTOR = ':root[data-palette]:where(:not([data-palette="contextcake"]))'
export const DERIVED_DARK_SELECTOR = ':root[data-palette]:where(:not([data-palette="contextcake"])[data-theme="dark"])'
export const DERIVED_SWATCH_SELECTOR = '.cc-theme-swatch[data-palette]:where(:not([data-palette="contextcake"]))'
export const DERIVED_SWATCH_DARK_SELECTOR = '.cc-theme-swatch[data-palette]:where(:not([data-palette="contextcake"])[data-theme="dark"])'

/** A family block's two selectors, on the root and on a swatch. */
export function familySelector(id: string, mode: 'light' | 'dark'): string {
  return `:root[data-palette="${id}"][data-theme="${mode}"]`
}
export function swatchSelector(id: string, mode: 'light' | 'dark'): string {
  return `.cc-theme-swatch[data-palette="${id}"][data-theme="${mode}"]`
}

/**
 * A block is a token block — allowed to carry literal colors — when one of its
 * selectors is `:root`, the dark `:root`, or a palette family block on
 * `:root` / `.cc-theme-swatch` keyed by `data-palette` and `data-theme`. A
 * bare `.cc-theme-swatch` (the picker's layout rule) is a component rule and
 * stays under the literal-color gate, hence the `+` on the swatch branch.
 */
export const TOKEN_BLOCK_SELECTOR_RE = /^(?::root(?:\[data-(?:theme|palette)="[a-z][a-z0-9-]*"\])*|\.cc-theme-swatch(?:\[data-(?:theme|palette)="[a-z][a-z0-9-]*"\])+)$/

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
 * The tokens a theme family declares per mode; `themes/_derived.css`
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

/**
 * A family's mode exactly as the cascade resolves it on <html>, in cascade
 * order: ContextCake's `:root` (0,1,0 — the fallback for anything nobody
 * redeclares), then the derived block and, in dark mode, its dark half
 * (0,2,0), then the family's own block (0,3,0). ContextCake's dark block is
 * palette-scoped (DARK_SELECTOR) and so does not apply to a family at all —
 * a hole in `_derived.css` therefore shows up here as ContextCake's LIGHT
 * value in a family's dark mode, which is what a user would see, as well as
 * failing gate (d).
 */
export function familyModes(id: PaletteId, css: string): PaletteMode[] {
  const blocks = parseCssBlocks(css)
  const out: PaletteMode[] = []
  for (const mode of ['light', 'dark'] as const) {
    const decls = new Map(ccTokens(declarationsFor(BLOCKS, LIGHT_SELECTOR)))
    for (const [token, value] of ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_SELECTOR))) decls.set(token, value)
    if (mode === 'dark') for (const [token, value] of ccTokens(declarationsFor(DERIVED_BLOCKS, DERIVED_DARK_SELECTOR))) decls.set(token, value)
    for (const [token, value] of ccTokens(declarationsFor(blocks, familySelector(id, mode)))) decls.set(token, value)
    out.push({ palette: id, mode, decls })
  }
  return out
}

/** Every (palette, mode) the contrast gate scores: ContextCake plus each shipped family. */
export const PALETTES: readonly PaletteMode[] = [
  ...contextCakeModes(),
  ...FAMILIES.filter((family) => family.id !== 'contextcake')
    .flatMap((family) => familyModes(family.id, FAMILY_FILES.get(family.id) ?? '')),
]
