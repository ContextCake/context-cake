import { useThemeMode } from '../theme-mode'
import { PALETTES, paletteFamily, type PaletteFamily } from '../themes/registry'

/**
 * Settings → Appearance → Theme: one tile per theme family. The same
 * SegmentedControl contract (`role="group"`, one `aria-pressed` button per
 * choice) so keyboard and assistive-tech behaviour match the other appearance
 * rows; a click applies the family immediately — there is no hover preview,
 * because the tiles ARE the preview: each half is a `.cc-theme-swatch` that
 * paints a miniature shell from that family's own tokens (see styles.css and
 * src/themes/_derived.css), so what a tile shows is what the app will wear.
 */
export function ThemePicker() {
  const { palette, setPalette } = useThemeMode()
  const selected = paletteFamily(palette)
  return (
    <>
      <div className="cc-theme-picker" role="group" aria-label="Theme">
        {PALETTES.map((family) => {
          const pressed = family.id === palette
          return (
            <button
              key={family.id}
              type="button"
              className="cc-theme-tile"
              aria-pressed={pressed}
              onClick={() => setPalette(family.id)}
            >
              <span className="cc-theme-tile-preview" aria-hidden="true">
                <Swatch id={family.id} mode="light" />
                <Swatch id={family.id} mode="dark" />
                {pressed && (
                  <span className="cc-theme-tile-check">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 6.5 2.5 2.5 4.5-5" /></svg>
                  </span>
                )}
              </span>
              <span className="cc-theme-tile-label">
                {family.label}
                <span className="cc-theme-tile-variants">{variantLabel(family)}</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="cc-theme-picker-note">{describeFamily(selected)}</p>
    </>
  )
}

/** A miniature shell painted from the family's own tokens: toolbar strip, page, a raised card with ink + caption lines and the three layer dots. */
function Swatch({ id, mode }: { id: PaletteFamily['id']; mode: 'light' | 'dark' }) {
  return (
    <span className="cc-theme-swatch" data-palette={id} data-theme={mode}>
      <span className="cc-theme-swatch-bar" />
      <span className="cc-theme-swatch-card">
        <span className="cc-theme-swatch-ink" />
        <span className="cc-theme-swatch-body" />
        <span className="cc-theme-swatch-dots"><span /><span /><span /></span>
      </span>
    </span>
  )
}

/** "Latte / Mocha" — the upstream names of the two halves. */
export function variantLabel(family: PaletteFamily): string {
  return [family.variants.light, family.variants.dark].filter((name): name is string => name !== null).join(' / ')
}

/** The line under the grid for the selected family: its variants and, for a third-party palette, whose it is. */
export function describeFamily(family: PaletteFamily): string {
  const variants = variantLabel(family)
  if (!family.attribution) return `${variants} · ContextCake’s own palette.`
  const { name, license, author } = family.attribution
  return `${variants} · Based on ${name} (${license}) by ${author}.`
}
