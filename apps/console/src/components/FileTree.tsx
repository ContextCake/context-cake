// The source navigator: a real tree widget over a layer's files, windowed so a
// 3,000-note vault costs the same as a 30-note one.
//
// Two things here are load-bearing and easy to get subtly wrong.
//
// 1. **Flat DOM, real tree semantics.** Windowing means the rows that exist are
//    a moving slice of the tree, so `role="group"` wrappers cannot be nested
//    around subtrees the way a static tree nests them. Every row instead
//    carries `aria-level`/`aria-setsize`/`aria-posinset` — the flattened form
//    the ARIA tree pattern defines for exactly this case. Directories carry
//    `aria-expanded`; the selected file carries `aria-selected`.
//
// 2. **Focus survives the window.** A focused row that scrolls out of the
//    rendered slice would be unmounted, and focus would fall to <body> — the
//    keyboard would go dead mid-navigation. Two rules prevent that: keyboard
//    movement scrolls the target into view *before* focusing it, and the active
//    row is rendered unconditionally even when it lies outside the slice. So
//    however the row went out of view (wheel, trackpad, a filter shrinking the
//    list), it is still in the DOM and still has focus.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { lc, type LayerId } from '../theme'
import type { LayerFile, LayerFiles } from '../types'

/** Fixed row height. Windowing math is index × this — keep it in sync with CSS. */
export const ROW_HEIGHT = 28
/** Rows rendered beyond each edge, so a fast scroll doesn't show gaps. */
const OVERSCAN = 8
/** Used until the scroll container has been measured (and in jsdom, where it never is). */
const FALLBACK_VIEWPORT = 640

/**
 * One row of the tree. Shaped after `apps/site/src/lib/pack-explorer.ts` —
 * the site's pack explorer already proved this flattening — plus what a
 * windowed, layer-aware navigator additionally needs: sibling position for
 * ARIA, a subtree file count, and the layer each row belongs to.
 */
export interface TreeEntry {
  id: string
  kind: 'dir' | 'file'
  name: string
  /** `<layer>/<rel>` for files — the exact path `/api/file` takes. */
  path: string
  /** Depth from the layer root; the layer row itself is 0. */
  depth: number
  parent: string
  layer: string
  /** 1-based position among siblings, and how many siblings there are. */
  pos: number
  size: number
  /** Files in this subtree (directories and layer roots only). */
  count: number
  file?: LayerFile
}

const byName = (a: TreeEntry, b: TreeEntry) =>
  (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)

/**
 * Layer listings → one pre-ordered entry list. Each layer contributes a root
 * row, and every `rel` with a slash in it becomes the directories it implies.
 */
export function buildTree(layers: LayerFiles[]): TreeEntry[] {
  const out: TreeEntry[] = []
  const roots: TreeEntry[] = []
  const children = new Map<string, TreeEntry[]>()

  for (const layer of layers) {
    const rootId = layer.layer
    const root: TreeEntry = {
      id: rootId, kind: 'dir', name: layer.layer, path: rootId, depth: 0,
      parent: '', layer: layer.layer, pos: 0, size: 0, count: 0,
    }
    roots.push(root)
    children.set(rootId, [])
    const dirs = new Map<string, TreeEntry>([[rootId, root]])

    for (const file of layer.files) {
      const parts = file.rel.split('/')
      let parentId = rootId
      root.count += 1
      for (let i = 0; i < parts.length - 1; i += 1) {
        const id = `${parentId}/${parts[i]}`
        let dir = dirs.get(id)
        if (!dir) {
          dir = {
            id, kind: 'dir', name: parts[i], path: id, depth: i + 1,
            parent: parentId, layer: layer.layer, pos: 0, size: 0, count: 0,
          }
          dirs.set(id, dir)
          children.set(id, [])
          children.get(parentId)!.push(dir)
        }
        dir.count += 1
        parentId = id
      }
      children.get(parentId)!.push({
        id: file.path, kind: 'file', name: file.name, path: file.path,
        depth: parts.length, parent: parentId, layer: layer.layer,
        pos: 0, size: 0, count: 0, file,
      })
    }
  }

  // Pre-order emit. An explicit stack rather than recursion: a vault nests as
  // deep as the user's folders do, and this runs on every filter keystroke.
  roots.sort(byName)
  roots.forEach((root, index) => { root.pos = index + 1; root.size = roots.length })
  const stack = [...roots].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    out.push(node)
    const kids = children.get(node.id)
    if (!kids || kids.length === 0) continue
    kids.sort(byName)
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      kids[i].pos = i + 1
      kids[i].size = kids.length
      stack.push(kids[i])
    }
  }
  return out
}

/** Pre-ordered entries → the rows a given expansion state actually shows. */
export function flattenTree(entries: TreeEntry[], isExpanded: (id: string) => boolean): TreeEntry[] {
  const out: TreeEntry[] = []
  let collapsedAt = -1
  for (const entry of entries) {
    if (collapsedAt >= 0) {
      if (entry.depth > collapsedAt) continue
      collapsedAt = -1
    }
    out.push(entry)
    if (entry.kind === 'dir' && !isExpanded(entry.id)) collapsedAt = entry.depth
  }
  return out
}

/** The directories a path sits inside, so a deep link can reveal its file. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'))
  return out
}

function Chevron() {
  return (
    <svg className="cc-tree-twisty" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  )
}

interface RowProps {
  entry: TreeEntry
  index: number
  active: boolean
  selected: boolean
  expanded: boolean
  layerId: LayerId | null
  onOpen: (entry: TreeEntry) => void
  register: (id: string, node: HTMLDivElement | null) => void
}

/**
 * Memoized because a filter keystroke re-renders the tree and every prop here
 * is either a primitive or a stable identity — nothing rebuilds unless the row
 * itself changed.
 */
const Row = memo(function Row({ entry, index, active, selected, expanded, layerId, onOpen, register }: RowProps) {
  const dir = entry.kind === 'dir'
  const root = entry.depth === 0
  const color = root && layerId ? lc(layerId) : null
  return (
    <div
      ref={(node) => register(entry.id, node)}
      role="treeitem"
      aria-level={entry.depth + 1}
      aria-posinset={entry.pos}
      aria-setsize={entry.size}
      aria-expanded={dir ? expanded : undefined}
      aria-selected={dir ? undefined : selected}
      tabIndex={active ? 0 : -1}
      data-kind={entry.kind}
      data-root={root ? 'true' : undefined}
      title={entry.path}
      className="cc-tree-row"
      style={{ top: index * ROW_HEIGHT, paddingLeft: 8 + entry.depth * 13 }}
      onClick={() => onOpen(entry)}
    >
      {dir ? <Chevron /> : <span className="cc-tree-leaf" aria-hidden="true" />}
      {color && <span className="cc-tree-dot" aria-hidden="true" style={{ background: color.strokeE }} />}
      <span className="cc-tree-name">{entry.name}</span>
      {dir && <span className="cc-tree-count">{entry.count}</span>}
    </div>
  )
})

export interface FileTreeProps {
  entries: TreeEntry[]
  /** Every directory starts open — what a text filter wants, since every row matched. */
  expandAll: boolean
  selected: string | null
  /**
   * A file whose folders should be opened to show it. Distinct from `selected`
   * on purpose: a selection the view made for itself must not reorganize the
   * tree, only one the user asked for.
   */
  reveal: string | null
  onSelect: (path: string) => void
  layerIds: Map<string, LayerId>
  label: string
}

export function FileTree({ entries, expandAll, selected, reveal, onSelect, layerIds, label }: FileTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  // Set only by the movement handlers: a re-render caused by data arriving must
  // never yank focus away from wherever the user actually is.
  const wantFocus = useRef(false)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const rootIds = useMemo(
    () => new Set(entries.filter((entry) => entry.depth === 0).map((entry) => entry.id)),
    [entries],
  )

  // Directories are closed until asked for. The layer roots are the exception —
  // a source with nothing open under it still has to show that it is there — as
  // are the ancestors of `reveal`, since a deep link must show its own file.
  const isExpanded = useCallback((id: string) => {
    if (expandAll) return true
    if (collapsed.has(id)) return false
    return rootIds.has(id) || opened.has(id)
  }, [collapsed, expandAll, opened, rootIds])

  useEffect(() => {
    if (!reveal) return
    const chain = ancestorsOf(reveal)
    setOpened((prev) => {
      if (chain.every((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of chain) next.add(id)
      return next
    })
    setCollapsed((prev) => {
      if (!chain.some((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of chain) next.delete(id)
      return next
    })
  }, [reveal])

  const visible = useMemo(() => flattenTree(entries, isExpanded), [entries, isExpanded])
  const indexById = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((entry, index) => map.set(entry.id, index))
    return map
  }, [visible])

  // There is always exactly one tab stop. When the active row disappears
  // (filter typed, its folder collapsed) the first row inherits it.
  useEffect(() => {
    if (activeId && indexById.has(activeId)) return
    setActiveId(visible[0]?.id ?? null)
  }, [activeId, indexById, visible])

  // How tall the window is. Measured, never assumed — but the measurement is
  // deliberately re-taken on scroll as well, because a first measurement taken
  // before the pane has been laid out would otherwise stick: the tree would
  // render a two-row window over a full-height column and only ever show the
  // top of the list, with nothing to correct it.
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

  const register = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rows.current.set(id, node)
    else rows.current.delete(id)
  }, [])

  /** Put a row inside the window before anything tries to focus it. */
  const ensureVisible = useCallback((index: number) => {
    const node = scrollRef.current
    if (!node) return
    const height = node.clientHeight || FALLBACK_VIEWPORT
    const top = index * ROW_HEIGHT
    const next = top < node.scrollTop
      ? top
      : top + ROW_HEIGHT > node.scrollTop + height
        ? top + ROW_HEIGHT - height
        : null
    if (next === null) return
    node.scrollTop = next
    // Committed to state as well as the DOM: jsdom never fires `scroll`, and a
    // real browser fires it a frame late, which would render the old window.
    setScrollTop(next)
  }, [])

  const focusRow = useCallback((index: number) => {
    const entry = visible[index]
    if (!entry) return
    ensureVisible(index)
    // Re-focusing the row that is already active would set a flag no re-render
    // ever clears (React bails on an identical state value), and the next
    // unrelated render would then steal focus. Focus it directly instead.
    if (entry.id === activeRef.current) {
      rows.current.get(entry.id)?.focus({ preventScroll: true })
      return
    }
    wantFocus.current = true
    setActiveId(entry.id)
  }, [ensureVisible, visible])

  useLayoutEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    if (activeId) rows.current.get(activeId)?.focus({ preventScroll: true })
  }, [activeId, scrollTop, visible])

  const setExpanded = useCallback((id: string, open: boolean) => {
    const root = rootIds.has(id)
    setOpened((prev) => {
      const next = new Set(prev)
      if (open) next.add(id); else next.delete(id)
      return next
    })
    setCollapsed((prev) => {
      const next = new Set(prev)
      // Layer roots default to open, so "closed" for them has to be recorded
      // rather than inferred from the absence of an open marker.
      if (!open && root) next.add(id)
      else next.delete(id)
      return next
    })
  }, [rootIds])

  const open = useCallback((entry: TreeEntry) => {
    const index = indexById.get(entry.id)
    if (index !== undefined) focusRow(index)
    if (entry.kind === 'dir') setExpanded(entry.id, !isExpanded(entry.id))
    else onSelect(entry.path)
  }, [focusRow, indexById, isExpanded, onSelect, setExpanded])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const index = activeId ? indexById.get(activeId) ?? -1 : -1
    if (index < 0) return
    const entry = visible[index]
    const expanded = entry.kind === 'dir' && isExpanded(entry.id)

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(Math.min(visible.length - 1, index + 1)); return
      case 'ArrowUp': event.preventDefault(); focusRow(Math.max(0, index - 1)); return
      case 'Home': event.preventDefault(); focusRow(0); return
      case 'End': event.preventDefault(); focusRow(visible.length - 1); return
      case 'ArrowRight':
        event.preventDefault()
        if (entry.kind === 'dir' && !expanded) setExpanded(entry.id, true)
        else if (expanded) focusRow(index + 1)
        return
      case 'ArrowLeft': {
        event.preventDefault()
        if (expanded) { setExpanded(entry.id, false); return }
        const parent = indexById.get(entry.parent)
        if (parent !== undefined) focusRow(parent)
        return
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        open(entry)
        return
      default:
    }
  }

  const total = visible.length
  const height = viewport || FALLBACK_VIEWPORT
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const activeIndex = activeId ? indexById.get(activeId) ?? -1 : -1

  const renderRow = (index: number) => {
    const entry = visible[index]
    return (
      <Row
        key={entry.id}
        entry={entry}
        index={index}
        active={entry.id === activeId}
        selected={entry.path === selected}
        expanded={entry.kind === 'dir' && isExpanded(entry.id)}
        layerId={entry.depth === 0 ? layerIds.get(entry.layer) ?? null : null}
        onOpen={open}
        register={register}
      />
    )
  }

  // The active row is rendered in its own slot, always, and is deliberately
  // left out of the windowed slice. That is what keeps focus alive: React
  // reconciles the slice and this slot separately, so a row that crossed
  // between them — which is exactly what happens when the window scrolls past
  // the focused row — would be unmounted and remounted, and the browser drops
  // focus to <body> when the old node leaves the document. Keeping it in one
  // fixed slot means it is never unmounted while it holds focus. Rows are
  // absolutely positioned by index, so render order is not visual order.
  const slice: React.ReactNode[] = []
  for (let i = first; i < last; i += 1) if (i !== activeIndex) slice.push(renderRow(i))

  return (
    <div
      ref={scrollRef}
      className="cc-tree-scroll"
      onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); measure() }}
    >
      <div
        role="tree"
        aria-label={label}
        className="cc-tree"
        style={{ height: total * ROW_HEIGHT }}
        onKeyDown={onKeyDown}
      >
        {slice}
        {activeIndex >= 0 && renderRow(activeIndex)}
      </div>
    </div>
  )
}
