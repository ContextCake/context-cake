// Windowing for a long list of rows of KNOWN, possibly different, heights —
// FileTree's technique (fixed 28px rows, index × height) generalized with a
// prefix sum: row i starts at offsets[i], the first visible row is found by
// binary search on the scroll position, and the window is that row through
// the last one that starts inside the viewport, plus overscan on each side.
//
// Two rules carried over from FileTree, because they are what keep the
// keyboard alive across the window:
//
// 1. The ACTIVE row (the roving tab stop) is always in the returned index
//    list even when it lies outside the window, spliced in at its own index so
//    DOM order stays visual order. Scrolling the row out of the window must not
//    unmount the node that has focus.
// 2. `ensureVisible(index)` moves the scroll position and commits it to state
//    in the same tick — jsdom never fires `scroll`, and a real browser fires it
//    a frame late, which would render the old window under the new focus.
//
// The scroll container's height is measured (ResizeObserver, re-taken on
// scroll) and falls back to FALLBACK_VIEWPORT until it is — which is also
// what jsdom renders with, so tests see a real, bounded window.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Used until the scroll container has been measured (and in jsdom, where it never is). */
export const FALLBACK_VIEWPORT = 640
/** Rows rendered beyond each edge of the viewport, so a fast scroll doesn't show gaps. */
const DEFAULT_OVERSCAN = 6

export interface VirtualWindow {
  /** Attach to the scrolling element. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Attach to the scrolling element's `onScroll`. */
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  /** Height the inner (positioned) container must have so the scrollbar is honest. */
  totalHeight: number
  /** Top offset of row `index` inside the inner container. */
  offsetOf: (index: number) => number
  /**
   * The row indices to render, ascending. The window plus overscan, with the
   * active row spliced in at its own position when it falls outside.
   */
  indices: number[]
  /** Scroll so row `index` is fully inside the viewport (no-op when it already is). */
  ensureVisible: (index: number) => void
}

export function useVirtualWindow(
  heights: readonly number[],
  { activeIndex = -1, overscan = DEFAULT_OVERSCAN }: { activeIndex?: number; overscan?: number } = {},
): VirtualWindow {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)

  // offsets[i] = top of row i; offsets[n] = total height.
  const offsets = useMemo(() => {
    const out = new Array<number>(heights.length + 1)
    let top = 0
    for (let i = 0; i < heights.length; i += 1) { out[i] = top; top += heights[i] }
    out[heights.length] = top
    return out
  }, [heights])
  const totalHeight = offsets[heights.length]

  const measure = useCallback(() => {
    const node = scrollRef.current
    if (node) setViewport((prev) => (prev === node.clientHeight ? prev : node.clientHeight))
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    measure()
    const frame = requestAnimationFrame(measure)
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [measure])

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
    measure()
  }, [measure])

  const ensureVisible = useCallback((index: number) => {
    const node = scrollRef.current
    if (!node || index < 0 || index >= heights.length) return
    const height = node.clientHeight || FALLBACK_VIEWPORT
    const top = offsets[index]
    const bottom = top + heights[index]
    const next = top < node.scrollTop
      ? top
      : bottom > node.scrollTop + height
        ? bottom - height
        : null
    if (next === null) return
    node.scrollTop = next
    setScrollTop(next)
  }, [heights, offsets])

  const indices = useMemo(() => {
    const total = heights.length
    if (total === 0) return []
    const height = viewport || FALLBACK_VIEWPORT
    // Binary search: the last row that starts at or before scrollTop.
    let lo = 0
    let hi = total - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= scrollTop) lo = mid; else hi = mid - 1
    }
    const first = Math.max(0, lo - overscan)
    let last = lo
    const bottom = scrollTop + height
    while (last < total && offsets[last] < bottom) last += 1
    last = Math.min(total, last + overscan)
    const out: number[] = []
    if (activeIndex >= 0 && activeIndex < first) out.push(activeIndex)
    for (let i = first; i < last; i += 1) out.push(i)
    if (activeIndex >= last && activeIndex < total) out.push(activeIndex)
    return out
  }, [heights.length, viewport, scrollTop, offsets, overscan, activeIndex])

  const offsetOf = useCallback((index: number) => offsets[index] ?? 0, [offsets])

  return { scrollRef, onScroll, totalHeight, offsetOf, indices, ensureVisible }
}
