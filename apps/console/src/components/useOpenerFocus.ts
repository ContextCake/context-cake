import { useCallback, useMemo, useRef } from 'react'

const FOCUSABLE_SELECTOR = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Focus-return for an imperatively opened dialog (Settings, the setup
 * wizard): `capture()` at the moment the dialog is told to open — before the
 * state flip, while `document.activeElement` is still the trigger — and
 * `restore()` right after the state flip that closes it.
 *
 * The opener is not always still there to focus: the wizard can auto-open
 * with no button at all (first run), and any trigger can have scrolled out
 * of the viewport or been unmounted underneath a still-open dialog. `restore`
 * walks the captured opener first, then `fallbackSelectors` in order, and
 * focuses the first candidate that is connected, focusable, and actually
 * visible (a zero-size node is read as "not yet laid out" rather than
 * hidden, so it is not excluded on that basis alone) — never <body>.
 */
export function useOpenerFocus(fallbackSelectors: readonly string[] = []) {
  const openerRef = useRef<HTMLElement | null>(null)

  const capture = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])

  const restore = useCallback(() => {
    const opener = openerRef.current
    openerRef.current = null
    window.requestAnimationFrame(() => {
      const candidates = [opener, ...fallbackSelectors.map((selector) => document.querySelector<HTMLElement>(selector))]
      candidates.find((candidate) => {
        if (!candidate?.isConnected) return false
        if (!candidate.matches(FOCUSABLE_SELECTOR)) return false
        const rect = candidate.getBoundingClientRect()
        const hasNoLayout = rect.width === 0 && rect.height === 0
        const visible = hasNoLayout || (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight)
        if (visible) candidate.focus()
        return visible
      })
    })
  }, [fallbackSelectors])

  return useMemo(() => ({ capture, restore }), [capture, restore])
}
