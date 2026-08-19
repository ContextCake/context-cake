// The theme families the console can wear. Metadata only — the colors live in
// `./<id>.css` (one file per family) and `./_derived.css`; the registry is
// what the picker renders and what `theme-mode.tsx` validates a stored
// palette id against. Keeping tokens out of here means adding a family is a
// CSS file plus one entry below, and `tokens.test.ts` holds the two in step
// (every id here has a file, every file has an id).
//
// The two appearance axes, in code and in the UI:
//   code `theme`   = UI "Appearance" — system / light / dark (`theme-mode.tsx`)
//   code `palette` = UI "Theme"      — one of the ids below, `data-palette` on <html>
//
// v1 ships only families with an official light AND dark variant. `variants`
// keeps `string | null` per mode so a later dark-only family (Nord, Monokai)
// can be listed with a "Dark only" badge rather than a fake light half.

export type PaletteId =
  | 'contextcake'
  | 'solarized'
  | 'catppuccin'
  | 'gruvbox'
  | 'tokyo-night'
  | 'rose-pine'
  | 'one'
  | 'github'

export interface PaletteAttribution {
  /** The upstream project's name as it should be credited. */
  name: string
  /** Author or organization. */
  author: string
  /** Canonical palette or project URL. */
  url: string
  license: 'MIT'
}

export interface PaletteFamily {
  id: PaletteId
  /** Label under the picker tile. */
  label: string
  /** The upstream names of the two variants ("Latte / Mocha"); null = no official variant for that mode. */
  variants: { light: string | null; dark: string | null }
  /** null for ContextCake's own palette. Full notices: apps/console/THIRD_PARTY_THEMES.md. */
  attribution: PaletteAttribution | null
}

export const DEFAULT_PALETTE: PaletteId = 'contextcake'

export const PALETTES: readonly PaletteFamily[] = [
  {
    id: 'contextcake',
    label: 'ContextCake',
    variants: { light: 'Light', dark: 'Dark' },
    attribution: null,
  },
  {
    id: 'solarized',
    label: 'Solarized',
    variants: { light: 'Light', dark: 'Dark' },
    attribution: { name: 'Solarized', author: 'Ethan Schoonover', url: 'https://ethanschoonover.com/solarized/', license: 'MIT' },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    variants: { light: 'Latte', dark: 'Mocha' },
    attribution: { name: 'Catppuccin', author: 'the Catppuccin organization', url: 'https://catppuccin.com/palette/', license: 'MIT' },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    variants: { light: 'Light', dark: 'Dark' },
    attribution: { name: 'Gruvbox', author: 'Pavel Pertsev', url: 'https://github.com/morhetz/gruvbox', license: 'MIT' },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    variants: { light: 'Light', dark: 'Night' },
    attribution: { name: 'Tokyo Night', author: 'enkia', url: 'https://github.com/enkia/tokyo-night-vscode-theme', license: 'MIT' },
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    variants: { light: 'Dawn', dark: 'Main' },
    attribution: { name: 'Rosé Pine', author: 'the Rosé Pine contributors', url: 'https://rosepinetheme.com/palette/', license: 'MIT' },
  },
  {
    id: 'one',
    label: 'One',
    variants: { light: 'Light', dark: 'Dark' },
    attribution: { name: 'Atom One', author: 'GitHub (Atom)', url: 'https://github.com/atom/one-dark-syntax', license: 'MIT' },
  },
  {
    id: 'github',
    label: 'GitHub',
    variants: { light: 'Light', dark: 'Dark' },
    attribution: { name: 'GitHub Primer', author: 'GitHub', url: 'https://github.com/primer/primitives', license: 'MIT' },
  },
]

export const PALETTE_IDS: readonly PaletteId[] = PALETTES.map((family) => family.id)

const ID_SET: ReadonlySet<string> = new Set(PALETTE_IDS)

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && ID_SET.has(value)
}

export function paletteFamily(id: PaletteId): PaletteFamily {
  return PALETTES.find((family) => family.id === id) ?? PALETTES[0]
}
