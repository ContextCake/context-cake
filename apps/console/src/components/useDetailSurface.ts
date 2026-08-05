import { useEffect, useRef, useState } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Mirror the 840 px CSS container boundary for dialog and focus behavior. */
export function useDetailSurface<TContainer extends HTMLElement, TPanel extends HTMLElement>(open: boolean) {
  const containerRef = useRef<TContainer>(null)
  const panelRef = useRef<TPanel>(null)
  const [overlay, setOverlay] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const width = container.getBoundingClientRect().width
      // A zero-width node is unmeasured (not a legitimate workspace); avoid
      // stealing focus during test/hidden-surface initialization.
      setOverlay(width > 0 && width < 840)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open || !overlay) return
    // The panel enters from outside the clipped workspace. Focusing it with
    // the browser default scroll behavior can silently shift the workspace's
    // horizontal scroll position, leaving the navigator text off-screen after
    // the sheet closes.
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open, overlay])

  const onKeyDown = (event: React.KeyboardEvent<TPanel>) => {
    if (!overlay || !open || event.key !== 'Tab' || !panelRef.current) return
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return {
    containerRef,
    panelRef,
    panelProps: {
      role: overlay ? 'dialog' : 'complementary',
      'aria-modal': overlay ? true : undefined,
      onKeyDown,
    } as const,
  }
}
