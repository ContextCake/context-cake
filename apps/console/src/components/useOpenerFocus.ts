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
  // Separate from openerRef because `null` there is itself a valid captured
  // state (no focusable activeElement, or the wizard's no-trigger first-run
  // open) that still means "run the fallback search". This flag is what
  // makes restore() idempotent: a real-Chrome repro found Settings closing
  // via Escape called restore() TWICE — the shell's own Escape handler closes
  // it, and SettingsView's internal Escape handler (fixed alongside this to
  // check event.defaultPrevented) fired too. The first call reads the real
  // opener and schedules a focus() for it; the second, with openerRef already
  // nulled, fell through to the generic fallback selectors and — because
  // rAF preserves scheduling order — its focus() ran *after* the first and
  // silently overrode the correct target with the wrong one (or, once the
  // fallback matched nothing at all in the ADD Source case, left focus on
  // <body>). Gating on `pendingRef` makes a second, spurious restore() a
  // no-op instead of a second, competing guess.
  const pendingRef = useRef(false)

  const capture = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    pendingRef.current = true
  }, [])

  const restore = useCallback(() => {
    if (!pendingRef.current) return
    pendingRef.current = false
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
