// The discrepancy list: groups with collapsible headers, item rows with a
// selection checkbox, windowed so 1,500 rows cost what 15 do.
//
// Flat DOM, real list semantics — the same trade FileTree makes. Windowing
// means the rows that exist are a moving slice, so a group's items cannot be
// nested inside its header; instead every row (header or item) is an
// `option` in one `listbox`, and a header option carries the group's name,
// size and open/closed state in its accessible name. `aria-selected` is the
// multi-selection (`aria-multiselectable`); the row whose detail is open is
// `aria-current`. One roving tab stop; Arrow/Home/End move it, Left/Right
// close/open a group, Space toggles selection, Enter opens the detail.
//
// Focus survives the window for the same two reasons it does in FileTree:
// keyboard movement scrolls the target into view BEFORE focusing it, and the
// active row is rendered even when it lies outside the slice (spliced in at
// its own index — see useVirtualWindow).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Conflict } from '../../data'
import { displayStatus, type ConflictGroup } from '../../discrepancy-summary'
import { useVirtualWindow } from '../../components/useVirtualWindow'
import { KIND_LABEL, STATUS_LABEL, plural } from './labels'

/** Fixed row heights. The windowing math is a prefix sum over these — keep them in sync with the CSS. */
export const GROUP_ROW_HEIGHT = 44
export const ITEM_ROW_HEIGHT = 128

export type ListRow =
  | { key: string; kind: 'group'; group: ConflictGroup }
  | { key: string; kind: 'item'; item: Conflict; group: ConflictGroup }

export const groupRowKey = (groupKey: string) => `g:${groupKey}`
export const itemRowKey = (id: string) => `i:${id}`

/** Groups → the rows a given collapse state actually shows, in visual order. */
export function flattenGroups(groups: ConflictGroup[], isCollapsed: (key: string) => boolean): ListRow[] {
  const out: ListRow[] = []
  for (const group of groups) {
    out.push({ key: groupRowKey(group.key), kind: 'group', group })
    if (isCollapsed(group.key)) continue
    for (const item of group.items) out.push({ key: itemRowKey(item.id), kind: 'item', item, group })
  }
  return out
}

function Twisty() {
  return (
    <svg className="cc-group-twisty" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  )
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  )
}

interface GroupRowProps {
  group: ConflictGroup
  top: number
  active: boolean
  collapsed: boolean
  checked: 'none' | 'some' | 'all'
  register: (key: string, node: HTMLDivElement | null) => void
  onToggle: (group: ConflictGroup) => void
  onCheck: (group: ConflictGroup, event: React.MouseEvent) => void
  onFocusRow: (key: string) => void
}

const GroupRow = memo(function GroupRow({ group, top, active, collapsed, checked, register, onToggle, onCheck, onFocusRow }: GroupRowProps) {
  const key = groupRowKey(group.key)
  const state = collapsed ? 'collapsed' : 'expanded'
  return (
    <div
      ref={(node) => register(key, node)}
      role="option"
      aria-selected={checked === 'all'}
      aria-label={`${group.label}, ${plural(group.count, 'item')}, ${group.actionable} actionable, ${state}`}
      tabIndex={active ? 0 : -1}
      data-row="group"
      data-collapsed={collapsed || undefined}
      className="cc-group-row"
      style={{ top, height: GROUP_ROW_HEIGHT }}
      onClick={() => { onFocusRow(key); onToggle(group) }}
    >
      <span
        className="cc-row-check"
        data-checked={checked === 'all' ? 'true' : checked === 'some' ? 'mixed' : undefined}
        aria-hidden="true"
        title={checked === 'all' ? 'Deselect this group' : 'Select this group'}
        onClick={(event) => { event.stopPropagation(); onFocusRow(key); onCheck(group, event) }}
      >{checked === 'all' ? <CheckMark /> : checked === 'some' ? <span className="cc-row-check-mixed" /> : null}</span>
      <Twisty />
      <span className="cc-group-label" title={group.label}>{group.label}</span>
      {group.sharedBestCandidate && <span className="cc-group-fix" title={`Every link in this group can be rewritten to ${group.sharedBestCandidate.id}`}>fix → {group.sharedBestCandidate.id}</span>}
      <span className="cc-group-count">{group.actionable === group.count ? String(group.count) : `${group.actionable} of ${group.count}`}</span>
    </div>
  )
})

interface ItemRowProps {
  item: Conflict
  top: number
  active: boolean
  current: boolean
  checked: boolean
  register: (key: string, node: HTMLDivElement | null) => void
  onOpen: (item: Conflict, event: React.MouseEvent) => void
  onCheck: (item: Conflict, event: React.MouseEvent) => void
  onFocusRow: (key: string) => void
}

const ItemRow = memo(function ItemRow({ item, top, active, current, checked, register, onOpen, onCheck, onFocusRow }: ItemRowProps) {
  const key = itemRowKey(item.id)
  const status = displayStatus(item)
  const brokenLink = item.kind === 'broken_link'
  return (
    <div
      ref={(node) => register(key, node)}
      role="option"
      aria-selected={checked}
      aria-current={current ? 'true' : undefined}
      tabIndex={active ? 0 : -1}
      data-row="item"
      data-selected={current}
      data-checked={checked || undefined}
      className="cc-conflict-row"
      style={{ top, height: ITEM_ROW_HEIGHT }}
      onClick={(event) => { onFocusRow(key); onOpen(item, event) }}
    >
      <span className="cc-conflict-row-top">
        <span
          className="cc-row-check"
          data-checked={checked || undefined}
          aria-hidden="true"
          title={checked ? 'Deselect' : 'Select'}
          onClick={(event) => { event.stopPropagation(); onFocusRow(key); onCheck(item, event) }}
        >{checked ? <CheckMark /> : null}</span>
        <span className="cc-kind-pill">{KIND_LABEL[item.kind ?? 'section_content']}</span>
        {brokenLink && item.bestCandidate && <span className="cc-fix-pill" title={`Suggested fix: rewrite to ${item.bestCandidate.id}`}>fix ready</span>}
        <span className="cc-conflict-row-status">{STATUS_LABEL[status]}</span>
      </span>
      <span className="cc-conflict-row-title" title={item.section}>{item.section}</span>
      <code title={item.concept}>{item.concept}</code>
      <span className="cc-conflict-row-foot">
        <span>{item.owner ?? 'Unassigned'} · {item.priority ?? 'unassigned'} priority</span>
        {brokenLink
          ? <span className="cc-conflict-row-target" title={item.target}>→ {item.target}</span>
          : <span>{plural(item.contributions.length, 'source')}</span>}
      </span>
    </div>
  )
})

export interface GroupedListProps {
  groups: ConflictGroup[]
  isCollapsed: (key: string) => boolean
  onToggleGroup: (key: string, collapsed: boolean) => void
  /** The row whose detail is open. */
  currentId: string | null
  /** Click / Enter on a row: make it current and open its detail. */
  onOpen: (id: string) => void
  selection: ReadonlySet<string>
  onSelectionChange: (next: Set<string>) => void
  emptyState: ReactNode
  label: string
}

export function GroupedList({ groups, isCollapsed, onToggleGroup, currentId, onOpen, selection, onSelectionChange, emptyState, label }: GroupedListProps) {
  const rows = useMemo(() => flattenGroups(groups, isCollapsed), [groups, isCollapsed])
  const heights = useMemo(() => rows.map((row) => (row.kind === 'group' ? GROUP_ROW_HEIGHT : ITEM_ROW_HEIGHT)), [rows])
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, index) => map.set(row.key, index))
    return map
  }, [rows])

  const nodes = useRef(new Map<string, HTMLDivElement>())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeKey
  const wantFocus = useRef(false)
  const hasFocus = useRef(false)
  // The last item clicked or toggled — the other end of a Shift+click range.
  const anchorRef = useRef<string | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const activeIndex = activeKey ? indexByKey.get(activeKey) ?? -1 : -1
  const virtual = useVirtualWindow(heights, { activeIndex })

  const register = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) nodes.current.set(key, node)
    else nodes.current.delete(key)
  }, [])

  const { ensureVisible } = virtual
  const focusRow = useCallback((index: number) => {
    const row = rowsRef.current[index]
    if (!row) return
    ensureVisible(index)
    // Re-focusing the row that is already active would set a flag no
    // re-render ever clears (React bails on an identical state value), and
    // the next unrelated render would then steal focus. Focus it directly.
    if (row.key === activeRef.current) {
      nodes.current.get(row.key)?.focus({ preventScroll: true })
      return
    }
    wantFocus.current = true
    setActiveKey(row.key)
  }, [ensureVisible])

  useLayoutEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    if (activeKey) nodes.current.get(activeKey)?.focus({ preventScroll: true })
  }, [activeKey, virtual.indices])

  // Exactly one tab stop. When the active row vanishes (its group closed, a
  // filter dropped it, a refetch removed it) the current row inherits it, else
  // the first row — and focus follows only if it was already inside the list.
  useEffect(() => {
    if (activeKey && indexByKey.has(activeKey)) return
    if (rows.length === 0) { if (activeKey !== null) setActiveKey(null); return }
    const preferred = currentId && indexByKey.has(itemRowKey(currentId)) ? itemRowKey(currentId) : rows[0].key
    if (hasFocus.current) focusRow(indexByKey.get(preferred) ?? 0)
    else setActiveKey(preferred)
  }, [activeKey, currentId, focusRow, indexByKey, rows])

  // A row's own click makes it the tab stop without stealing focus from where
  // the pointer already put it.
  const onFocusRow = useCallback((key: string) => {
    if (key !== activeRef.current) setActiveKey(key)
  }, [])

  const toggleItem = useCallback((id: string) => {
    const next = new Set(selectionRef.current)
    if (next.has(id)) next.delete(id); else next.add(id)
    anchorRef.current = id
    onSelectionChange(next)
  }, [onSelectionChange])

  /** Select every item row between the anchor and `id` (visual order, expanded groups only). */
  const rangeTo = useCallback((id: string) => {
    const anchor = anchorRef.current
    const items = rowsRef.current.filter((row): row is Extract<ListRow, { kind: 'item' }> => row.kind === 'item')
    const from = anchor ? items.findIndex((row) => row.item.id === anchor) : -1
    const to = items.findIndex((row) => row.item.id === id)
    if (from < 0 || to < 0) { toggleItem(id); return }
    const next = new Set(selectionRef.current)
    for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) next.add(items[i].item.id)
    onSelectionChange(next)
  }, [onSelectionChange, toggleItem])

  const checkGroup = useCallback((group: ConflictGroup) => {
    const next = new Set(selectionRef.current)
    const all = group.items.every((item) => next.has(item.id))
    for (const item of group.items) { if (all) next.delete(item.id); else next.add(item.id) }
    onSelectionChange(next)
  }, [onSelectionChange])

  const onItemOpen = useCallback((item: Conflict, event: React.MouseEvent) => {
    if (event.shiftKey) { event.preventDefault(); rangeTo(item.id); return }
    if (event.metaKey || event.ctrlKey) { toggleItem(item.id); return }
    anchorRef.current = item.id
    onOpen(item.id)
  }, [onOpen, rangeTo, toggleItem])

  const onItemCheck = useCallback((item: Conflict, event: React.MouseEvent) => {
    if (event.shiftKey) rangeTo(item.id); else toggleItem(item.id)
  }, [rangeTo, toggleItem])

  const onGroupToggle = useCallback((group: ConflictGroup) => {
    onToggleGroup(group.key, !isCollapsed(group.key))
  }, [isCollapsed, onToggleGroup])

  const onGroupCheck = useCallback((group: ConflictGroup) => checkGroup(group), [checkGroup])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const index = activeKey ? indexByKey.get(activeKey) ?? -1 : -1
    if (index < 0) return
    const row = rows[index]
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(Math.min(rows.length - 1, index + 1)); return
      case 'ArrowUp': event.preventDefault(); focusRow(Math.max(0, index - 1)); return
      case 'Home': event.preventDefault(); focusRow(0); return
      case 'End': event.preventDefault(); focusRow(rows.length - 1); return
      case 'ArrowRight':
        event.preventDefault()
        if (row.kind === 'group') {
          if (isCollapsed(row.group.key)) onToggleGroup(row.group.key, false)
          else if (row.group.items.length > 0) focusRow(index + 1)
        }
        return
      case 'ArrowLeft': {
        event.preventDefault()
        if (row.kind === 'group') { if (!isCollapsed(row.group.key)) onToggleGroup(row.group.key, true); return }
        const header = indexByKey.get(groupRowKey(row.group.key))
        if (header !== undefined) focusRow(header)
        return
      }
      case ' ':
        event.preventDefault()
        if (row.kind === 'item') toggleItem(row.item.id); else checkGroup(row.group)
        return
      case 'Enter':
        event.preventDefault()
        if (row.kind === 'item') { anchorRef.current = row.item.id; onOpen(row.item.id) } else onGroupToggle(row.group)
        return
      default:
    }
  }

  const rendered: ReactNode[] = []
  for (const index of virtual.indices) {
    const row = rows[index]
    if (!row) continue
    if (row.kind === 'group') {
      const selected = row.group.items.filter((item) => selection.has(item.id)).length
      rendered.push(
        <GroupRow
          key={row.key}
          group={row.group}
          top={virtual.offsetOf(index)}
          active={row.key === activeKey}
          collapsed={isCollapsed(row.group.key)}
          checked={selected === 0 ? 'none' : selected === row.group.items.length ? 'all' : 'some'}
          register={register}
          onToggle={onGroupToggle}
          onCheck={onGroupCheck}
          onFocusRow={onFocusRow}
        />,
      )
    } else {
      rendered.push(
        <ItemRow
          key={row.key}
          item={row.item}
          top={virtual.offsetOf(index)}
          active={row.key === activeKey}
          current={row.item.id === currentId}
          checked={selection.has(row.item.id)}
          register={register}
          onOpen={onItemOpen}
          onCheck={onItemCheck}
          onFocusRow={onFocusRow}
        />,
      )
    }
  }

  return (
    <div
      ref={virtual.scrollRef}
      className="cc-conflict-list"
      role="listbox"
      aria-multiselectable="true"
      aria-label={label}
      onScroll={virtual.onScroll}
      onKeyDown={onKeyDown}
      onFocus={() => { hasFocus.current = true }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hasFocus.current = false }}
    >
      {rows.length === 0
        ? emptyState
        : <div className="cc-conflict-virtual" style={{ height: virtual.totalHeight }}>{rendered}</div>}
    </div>
  )
}
