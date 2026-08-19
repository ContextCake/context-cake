// Sources view: manage the layers feeding the cascade — rename, reposition,
// repoint, sync, and remove ride the engine's source API (PATCH/DELETE
// /api/sources, PUT /api/sources/order, POST /api/sources/sync). A
// folder-backed source can be pointed at a different folder in place; a repo
// or an MCP command genuinely can't be, and the UI says which case you are in
// rather than telling everyone to remove and re-add. Errors render verbatim —
// including the engine's pack-invariant messages — never paraphrased into
// vagueness.
//
// Precedence is shown as a POSITION (#1 wins), never as the manifest's level
// integer — see cascade-order.ts. The one exception is the "Manifest level"
// metadata row, kept for people who edit manifest.json by hand. Reorder mode
// (live only) commits every move immediately: one PUT, one reload, no pending
// local order that could disagree with what the engine holds.
// Demo mode shows the same rows read-only.
import { useEffect, useMemo, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { apiFetch, progressLabel, progressPercent } from '../api'
import { computeCascadeOrder, moveTo, rankLabel, type CascadeOrderEntry } from '../cascade-order'
import { CascadePosition } from '../components/CascadePosition'
import { ArrowDownIcon, ArrowUpIcon, GripIcon } from '../components/icons'
import { LayerChip } from '../components/LayerChip'
import { useDetailSurface } from '../components/useDetailSurface'
import { filesRevalidation, useLayerFiles } from '../layer-files'
import { useReveal } from '../reveal'
import { useStoreData, useStoreInput } from '../store'
import type { Source } from '../data'
import type { LayerFiles } from '../types'

// Sync of a clone-backed source runs `git pull` server-side (bounded at 120s
// there) — same headroom as the wizard's mutations.
const MUTATION_TIMEOUT_MS = 150_000
// After a reorder commits, how long the list may stay stale before another
// refresh is asked for, and how many times — then the controls come back with
// a warning rather than staying locked on a store that will not catch up.
const REORDER_REFRESH_MS = 6_000
const REORDER_REFRESH_RETRIES = 5

async function callApi(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, { ...init, signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS) })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return data as Record<string, unknown>
}

const statusColor = (s: Source['status']) =>
  s === 'error' ? C.amberStrokeE : s === 'degraded' ? C.amberStroke : s === 'serving' ? C.tealStrokeE : s === 'empty' ? C.lineStrong : C.blueStroke

/** 'synced' and 'indexing' share a hue, so the dot alone never carries the state —
 *  the row text and the status word beside it do. */

/**
 * A source with its cascade position attached — every row and panel below
 * reads one of these. A quarantined entry has no position (`rank: null`): it
 * takes no part in resolution, and the engine will not give it one either.
 */
type RankedSource = CascadeOrderEntry<Source> | (Source & { rank: null; tied: false })

/** The chip/row wording for a position: `#1 in cascade`, or the honest absence of one. */
function positionText(s: RankedSource): string {
  return s.rank === null ? 'no position — invalid entry' : `${rankLabel(s)} in cascade`
}

/**
 * What a row says under the name. A source mid-index has no concept count worth
 * quoting — "0 concepts" next to a green "synced" was the app claiming to be
 * finished with work it had barely started.
 */
function rowSummary(s: RankedSource): string {
  const base = `${s.sourceKind} · ${positionText(s)}`
  if (s.status === 'indexing') return `${base} · ${progressLabel(s.indexing)}`
  const count = `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`
  return `${base} · ${count}${s.indexing?.refreshing ? ' · refreshing' : ''}`
}

/** Two orders are the same list — used to notice when the store has caught up with a reorder. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/**
 * The progress block on the detail panel. Two shapes, because the engine
 * distinguishes two situations: nothing to serve yet (a real wait, with a bar),
 * and a good answer being refreshed behind the scenes (a note, no bar — holding
 * a spinner in front of data the user already has is the lie in the other
 * direction).
 */
function ProgressBlock({ source }: { source: Source }) {
  const progress = source.indexing
  if (source.status === 'indexing') {
    const percent = progressPercent(progress)
    return (
      <div style={css(`display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:8px; background:${C.blueFill}; border:1px solid ${C.blueSoft};`)}>
        <div style={css(`display:flex; align-items:baseline; justify-content:space-between; gap:10px; font-size:12px; font-weight:600; color:${C.blueText};`)}>
          <span>{progressLabel(progress)}</span>
          {percent != null && <span style={css(`font-family:${MONO}; font-size:11px;`)}>{percent}%</span>}
        </div>
        <div
          role="progressbar"
          aria-label={`Indexing ${source.name}`}
          aria-valuetext={progressLabel(progress)}
          {...(percent == null ? {} : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
          style={css(`height:5px; border-radius:999px; background:${C.track}; overflow:hidden;`)}
        >
          <div style={css(`height:100%; width:${percent ?? 30}%; border-radius:999px; background:${C.blueStroke}; transition:width 220ms var(--cc-ease-out);`)} />
        </div>
        <span style={css(`font-size:11.5px; line-height:1.5; color:${C.blueText2};`)}>
          Concepts from this source appear as they land. You can keep working while it reads.
        </span>
      </div>
    )
  }
  if (!progress?.refreshing) return null
  return (
    <p role="status" style={css(`margin:0; font-size:11.5px; line-height:1.5; color:${C.caption};`)}>
      Serving {source.conceptCount} concept{source.conceptCount === 1 ? '' : 's'} and refreshing in the background.
    </p>
  )
}

/** ISO timestamps read better as local time; unparseable values pass through. */
function fmtTime(iso: string): string {
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString()
}

/**
 * The "Last error" metadata line. `lastErrorAt` alone used to render here — a
 * bare date beside a live `s.error` string one field down, so a source that
 * was actively failing still read "None" at a glance. The message is the
 * fact that matters; the date is context for it, not a substitute.
 */
function lastErrorSummary(s: Source): string {
  if (s.error) return s.lastErrorAt ? `${s.error} · ${fmtTime(s.lastErrorAt)}` : s.error
  if (s.lastErrorAt) return fmtTime(s.lastErrorAt)
  return 'None'
}

/** Sync applies to REST github layers and to clone-backed layers (origin set). */
function canSync(s: Source): boolean {
  return !s.quarantined && (s.sourceKind === 'github' || Boolean(s.origin))
}

/**
 * Whether this source's folder can be repointed in place. Mirrors the engine's
 * own refusal (service.mjs `pathPatchRefusal`) so the form never offers a field
 * the PATCH would reject: a remote source has no folder, and a clone-backed
 * layer's folder belongs to Sync.
 */
function canEditPath(s: Source): boolean {
  if (s.quarantined || s.origin) return false
  return s.sourceKind === 'okf-local' || s.sourceKind === 'files'
}

/**
 * The honest version of the old "remove the source and add it again" line, kept
 * only for the sources where it is still true. A folder-backed source returns
 * null — it has a path field now, and repeating the sentence there was the
 * whole field complaint.
 */
function immutableNote(s: Source): string | null {
  if (canEditPath(s)) return null
  if (s.sourceKind === 'mcp') return 'This source is reached by running a command. To point it at a different MCP server, remove it and add it again.'
  if (s.sourceKind === 'github') return 'This source is read from its repository over the GitHub API. To follow a different repo, remove it and add it again.'
  if (s.origin) return 'This source is a clone, and its folder is managed by Sync. To follow a different repository, remove it and add it again.'
  return 'The location of this source is fixed. To change it, remove the source and add it again.'
}

function btnSmallGhost(): React.CSSProperties {
  return css(`padding:6px 11px; background:transparent; border:1px solid ${C.line}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.caption};`)
}
function btnSmallDanger(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.amberFill}; border:1px solid ${C.amberStrokeE}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.amberText};`)
}
function btnSmallPrimary(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; border-radius:8px; cursor:pointer; font:inherit; font-weight:600; font-size:11.5px; color:${C.tealText};`)
}
function btnSmallDisabled(): React.CSSProperties {
  return css(`padding:6px 11px; background:${C.neutralFill}; border:1px solid ${C.line}; border-radius:8px; cursor:not-allowed; font:inherit; font-weight:600; font-size:11.5px; color:${C.faint};`)
}

function LiveMarker() {
  return (
    <span
      title="This layer captures and shares team context. Removing or renaming it disables team capture for this machine."
      style={css(`display:inline-flex; align-items:center; gap:5px; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:${C.amberFill}; color:${C.amberText};`)}
    >
      <span aria-hidden="true" style={css(`width:5px; height:5px; border-radius:999px; background:${C.amberStrokeE};`)} />
      live team layer
    </span>
  )
}

function LiveWarning({ verb }: { verb: 'Removing' | 'Renaming' }) {
  return (
    <div role="alert" style={css(`padding:9px 11px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText};`)}>
      This is the live team layer. {verb} it disables team capture for this machine
      {verb === 'Renaming' ? ' — staged captures fail closed when the binding changes.' : '.'}
    </div>
  )
}

function CredentialWarning({ source }: { source: Source }) {
  if (source.authState !== 'missing-token' && source.authState !== 'host-mismatch') return null
  const alias = source.authAlias ?? 'unknown'
  const isEnv = alias.startsWith('env:')
  const label = isEnv ? `Environment credential ${alias.slice(4)}` : `Credential keychain:${alias}`
  const text = source.authState === 'host-mismatch'
    ? `${label} was withheld because it is bound to a different GitHub host.`
    : isEnv
      ? `${label} is not set in the engine environment.`
      : `${label} is not connected. Add it in Settings → Connections.`
  return (
    <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
      {text}
    </div>
  )
}

type Panel = { name: string; kind: 'edit' | 'remove' } | null

/**
 * What the panel says about a source's files. A source with no folder on disk
 * is a real, healthy state — an MCP graph or a repo read over the API — and the
 * row says which, rather than leaving a blank that reads as a failure.
 */
function filesSummary(source: Source, entry: LayerFiles | undefined, known: boolean): string {
  if (entry) return `${entry.fileCount}${entry.truncated ? '+' : ''} file${entry.fileCount === 1 ? '' : 's'}`
  if (!known) return 'Reading…'
  if (source.sourceKind === 'mcp') return 'None on this machine — remote graph'
  if (source.sourceKind === 'github') return 'None on this machine — read over the API'
  return 'None on this machine'
}

export function Sources({ onAddSource }: { onAddSource?: () => void }) {
  const { mode, sources, reload, reloadKey, openFilesScope, indexingControl, canControlIndexing, reorderSources } = useStoreData()
  const { query } = useStoreInput()
  const live = mode === 'live'
  // The same listing the Files view builds its tree from: a source's file count
  // and root path are already in that payload, and were being thrown away.
  const { layers: fileLayers } = useLayerFiles(mode, filesRevalidation(sources, reloadKey))
  const filesByLayer = useMemo(() => {
    const map = new Map<string, LayerFiles>()
    for (const entry of fileLayers ?? []) map.set(entry.layer, entry)
    return map
  }, [fileLayers])

  const finder = useReveal()
  const [panel, setPanel] = useState<Panel>(null)
  const [editName, setEditName] = useState('')
  const [editPath, setEditPath] = useState('')
  const [editPosition, setEditPosition] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  // Which source an indexing control is in flight for — one at a time, and
  // the button that asked stays visibly busy until the engine answers.
  const [controlling, setControlling] = useState<string | null>(null)
  const runControl = async (action: 'pause' | 'resume' | 'cancel' | 'reindex', name: string) => {
    if (controlling) return
    setControlling(name)
    try { await indexingControl(action, { source: name }) } finally { setControlling(null) }
  }
  const [notice, setNotice] = useState<{ name: string; text: string } | null>(null)
  const [syncErr, setSyncErr] = useState<{ name: string; text: string } | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)

  const normalizedQuery = (query ?? '').trim().toLowerCase()
  // Every invalid manifest entry, off the unfiltered list: what a repair has to
  // clear is a property of the manifest, not of what the search box is showing.
  const invalid = useMemo(() => sources.filter((source) => source.quarantined), [sources])
  // Cascade order — rank ascending, ties by name (code-point, matching the
  // engine) — is the one order this view uses, so the position a row shows,
  // the list the drawer's select offers and the list a reorder sends agree.
  // Quarantined entries are not in it: they contribute nothing to resolution
  // and the engine refuses to give them a position, so ranking them would put
  // a "#2 (tied)" on a row that is not in the cascade at all. They stay in the
  // navigator (removal is the repair) — listed last, without a position.
  const cascade = useMemo(() => computeCascadeOrder(sources.filter((source) => !source.quarantined)), [sources])
  const rows = useMemo<RankedSource[]>(
    () => [...cascade, ...invalid.map((source): RankedSource => ({ ...source, rank: null, tied: false }))],
    [cascade, invalid],
  )
  const ordered = rows
    .filter((source) => !normalizedQuery || [
      source.name,
      source.layer,
      source.sourceKind,
      source.status,
      source.error,
      source.origin,
    ].some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery)))
  // The invalid entries a removal of THIS row has to take with it. Any write
  // rewrites the whole manifest and the engine only saves one that validates,
  // so an invalid entry blocks removing a perfectly healthy source just as
  // surely as it blocks removing another invalid one.
  const alsoInvalid = (s: Source) => invalid.filter((source) => source.name !== s.name)

  useEffect(() => {
    if (selectedName && sources.some((source) => source.name === selectedName)) return
    setSelectedName(ordered[0]?.name ?? null)
  }, [ordered, selectedName, sources])

  const selected = ordered.find((source) => source.name === selectedName) ?? ordered[0] ?? null
  const selectSource = (name: string, button?: HTMLButtonElement) => {
    setSelectedName(name)
    selectedButton.current = button ?? null
    setDetailOpen(true)
  }
  const closeDetail = () => {
    setDetailOpen(false)
    requestAnimationFrame(() => selectedButton.current?.focus({ preventScroll: true }))
  }
  useEffect(() => {
    const close = () => closeDetail()
    window.addEventListener('contextcake:close-detail', close)
    return () => window.removeEventListener('contextcake:close-detail', close)
  }, [])

  // The full cascade as a name list — exactly what PUT /api/sources/order
  // takes — and one source's 1-based position in it.
  const orderNames = useMemo(() => cascade.map((source) => source.name), [cascade])
  const positionOf = (name: string) => orderNames.indexOf(name) + 1

  const openEdit = (s: Source) => {
    setPanel({ name: s.name, kind: 'edit' })
    setEditName(s.name)
    setEditPath(filesByLayer.get(s.name)?.root ?? '')
    setEditPosition(positionOf(s.name))
    setErr(null)
  }
  const openRemove = (s: Source) => { setPanel({ name: s.name, kind: 'remove' }); setErr(null) }
  const closePanel = () => { setPanel(null); setErr(null) }

  /**
   * Save the drawer: rename/repoint go through PATCH, a position change
   * through the reorder op — two writes, in that order, so the reorder can
   * name the source by its NEW name. A failure says which of the two it was:
   * a rename that landed with a position that did not is a different state
   * from nothing having happened, and the user has to know which one they
   * are looking at.
   */
  const saveEdit = async (s: Source) => {
    const newName = editName.trim()
    if (!newName) { setErr('Give this source a short name.'); return }
    const currentRoot = filesByLayer.get(s.name)?.root ?? ''
    const newPath = editPath.trim()
    const body: Record<string, unknown> = { name: s.name }
    if (newName !== s.name) body.newName = newName
    // Only a real move is sent. An untouched field must not re-key the index
    // entry and put a settled source back through a full read for nothing.
    if (canEditPath(s) && newPath && newPath !== currentRoot) body.path = newPath
    const patching = body.newName !== undefined || body.path !== undefined
    const currentPosition = positionOf(s.name)
    const repositioning = editPosition !== currentPosition
    if (!patching && !repositioning) { closePanel(); return }
    setBusy(true)
    setErr(null)
    let patched = false
    try {
      let out: Record<string, unknown> = {}
      if (patching) {
        out = await callApi('/api/sources', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        patched = true
      }
      if (repositioning) {
        const renamed = orderNames.map((name) => (name === s.name ? newName : name))
        await reorderSources(moveTo(renamed, newName, editPosition - 1))
      }
      closePanel()
      // A move means a re-index, and the row is about to say "indexing" on its
      // own. Naming the cause first is the difference between progress and a
      // source that looks like it broke when you saved it.
      if (out.reindexing === true) {
        setNotice({
          name: newName,
          text: out.hasDocuments === false
            ? 'Pointed at the new folder — no documents spotted there yet, so it may come back empty.'
            : 'Pointed at the new folder — reading it now.',
        })
      } else if (repositioning) {
        setNotice({ name: newName, text: `Moved to position ${editPosition} of ${orderNames.length}.` })
      }
      reload()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (patched) {
        // The rename/repoint is already on disk; only the position is not.
        // Refresh so the panel shows the source under its new name — and
        // follow it there: the drawer and the error live on the row's name,
        // and a reload that renames the row underneath them would otherwise
        // close the drawer with the only copy of the message. The engine's
        // own words stay verbatim.
        setPanel({ name: newName, kind: 'edit' })
        setSelectedName(newName)
        reload()
        setErr(`${body.newName !== undefined ? 'Renamed' : 'Folder updated'}, but the position change failed — ${message}`)
      } else if (patching && repositioning) {
        setErr(`Nothing was changed — ${message}`)
      } else {
        setErr(message)
      }
    } finally {
      setBusy(false)
    }
  }

  // ---- Reorder mode ----------------------------------------------------------
  // Live only, and off while any manifest entry is quarantined: the engine
  // refuses a reorder outright (409 REORDER_BLOCKED) because an invalid entry
  // has no position to be given, so the toggle says so up front instead of
  // letting every drag fail. Each move is committed as it happens: one PUT
  // with the complete new order, then reload(). The list is always drawn from
  // the store — never from a local copy that could drift from the manifest.
  const [reordering, setReordering] = useState(false)
  // The move in flight, and the order the engine accepted that the store has
  // not caught up with yet (reload() is asynchronous). Both gate the controls;
  // neither is used to DRAW the list. Without the second, two quick presses of
  // "Move up" would compute the second move from the pre-move order and send
  // the same list twice — the source moves once and the user sees one press
  // swallowed. `awaiting` is cleared when the store's order matches it, or by
  // a timeout if some other writer got there first.
  const [movingName, setMovingName] = useState<string | null>(null)
  // `next` is the order the engine accepted; `prev` the order the move was
  // computed from, so a stale store can be told apart from a fresh one that
  // some other writer changed; `retries` counts the refreshes asked for since.
  const [awaiting, setAwaiting] = useState<{ next: string[]; prev: string[]; retries: number } | null>(null)
  const [reorderErr, setReorderErr] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [dragName, setDragName] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ name: string; edge: 'before' | 'after' } | null>(null)
  const moveButtons = useRef(new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>())
  // The arrow a keyboard move was made with, to be re-focused once the store
  // has caught up. Focus has to be handled explicitly: a row that reaches an
  // end has that arrow disabled, and a disabled control drops focus to the
  // document — the one thing a keyboard user cannot recover from by feel.
  const pendingFocus = useRef<{ name: string; which: 'up' | 'down' } | null>(null)
  const canReorder = live && invalid.length === 0 && sources.length > 1
  const reorderLocked = movingName !== null || awaiting !== null

  useEffect(() => {
    if (!awaiting) return
    // Caught up — or moved on: a list that is neither the old order nor the
    // accepted one came from another writer, and it is fresh, so it unlocks.
    if (!sameOrder(orderNames, awaiting.prev) || sameOrder(orderNames, awaiting.next)) {
      setAwaiting(null)
      setReorderErr((current) => (current?.startsWith('Saved') ? null : current))
      return
    }
    // Still the pre-move list after a while: the reload after the PUT did not
    // land (the refresh banner says why). Unlocking over the OLD list would let
    // the next move be computed from it and silently undo the one the engine
    // already holds, so the lock stays and another refresh is asked for — a
    // bounded number of times, then the list is handed back with a warning
    // rather than held forever.
    const timer = setTimeout(() => {
      if (awaiting.retries >= REORDER_REFRESH_RETRIES) {
        setAwaiting(null)
        setReorderErr('Saved; the list could not be refreshed — it may be out of date. Leave and re-enter Reorder to continue.')
        return
      }
      setAwaiting({ ...awaiting, retries: awaiting.retries + 1 })
      setReorderErr(`Saved, but the list could not be refreshed yet — retrying (${awaiting.retries + 1} of ${REORDER_REFRESH_RETRIES}).`)
      reload()
    }, REORDER_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [awaiting, orderNames, reload])

  useEffect(() => {
    if (reorderLocked || !pendingFocus.current) return
    const { name, which } = pendingFocus.current
    pendingFocus.current = null
    const refs = moveButtons.current.get(name)
    if (!refs) return
    // The arrow that was pressed, unless the row reached an end and it is
    // now disabled — then the row's other arrow, which is still a way onward.
    const wanted = refs[which]
    const target = wanted && !wanted.disabled ? wanted : which === 'up' ? refs.down : refs.up
    target?.focus()
  }, [reorderLocked])

  // Leaving the mode (or losing the right to it) drops every transient bit
  // of drag state, so a half-finished drag can't leak into the ordinary list.
  useEffect(() => {
    if (reordering && canReorder) return
    setReordering(false)
    setDragName(null)
    setDropTarget(null)
  }, [canReorder, reordering])

  const commitMove = async (name: string, toIndex: number, via?: 'up' | 'down') => {
    if (reorderLocked) return
    const next = moveTo(orderNames, name, toIndex)
    if (sameOrder(next, orderNames)) return
    const position = next.indexOf(name) + 1
    setMovingName(name)
    setReorderErr(null)
    if (via) pendingFocus.current = { name, which: via }
    try {
      await reorderSources(next)
      setAwaiting({ next, prev: orderNames, retries: 0 })
      setAnnouncement(`Moved ${name} to position ${position} of ${next.length}`)
      reload()
    } catch (e) {
      pendingFocus.current = null
      setReorderErr(e instanceof Error ? e.message : String(e))
    } finally {
      setMovingName(null)
    }
  }

  const registerMoveButton = (name: string, which: 'up' | 'down') => (el: HTMLButtonElement | null) => {
    const entry = moveButtons.current.get(name) ?? { up: null, down: null }
    entry[which] = el
    moveButtons.current.set(name, entry)
  }

  const onRowDragStart = (name: string) => (event: React.DragEvent<HTMLLIElement>) => {
    if (reorderLocked) { event.preventDefault(); return }
    // text/plain so the same drag reads sensibly anywhere else it lands; the
    // state copy is for browsers that withhold dataTransfer until drop.
    event.dataTransfer.setData('text/plain', name)
    event.dataTransfer.effectAllowed = 'move'
    setDragName(name)
  }
  const onRowDragOver = (name: string) => (event: React.DragEvent<HTMLLIElement>) => {
    if (reorderLocked || !dragName) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (name === dragName) { setDropTarget(null); return }
    // Before or after this row, by where the pointer is inside it. Everything
    // is relative to the row's own box, so a scrolled list reads the same.
    const rect = event.currentTarget.getBoundingClientRect()
    const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTarget((current) => (current?.name === name && current.edge === edge ? current : { name, edge }))
  }
  const onRowDrop = (name: string) => (event: React.DragEvent<HTMLLIElement>) => {
    event.preventDefault()
    const dragged = event.dataTransfer.getData('text/plain') || dragName
    const edge = dropTarget?.name === name ? dropTarget.edge : 'after'
    setDragName(null)
    setDropTarget(null)
    if (!dragged || dragged === name) return
    const from = orderNames.indexOf(dragged)
    const at = orderNames.indexOf(name)
    if (from === -1 || at === -1) return
    // Where `dragged` lands once it has been lifted out of the list.
    let to = edge === 'before' ? at : at + 1
    if (from < to) to -= 1
    void commitMove(dragged, to)
  }
  const endDrag = () => { setDragName(null); setDropTarget(null) }

  // A removal carries the invalid entries with it, and the panel names them
  // before the click. The engine will only persist a manifest that validates,
  // so while anything is invalid, removing this row alone is refused — one
  // request naming all of them is the only thing that repairs the file.
  // `name` repeats; the engine reads them all.
  const confirmRemove = async (s: Source) => {
    const names = [s.name, ...alsoInvalid(s).map((source) => source.name)]
    setBusy(true)
    setErr(null)
    try {
      await callApi(`/api/sources?${names.map((n) => `name=${encodeURIComponent(n)}`).join('&')}`, { method: 'DELETE' })
      closePanel()
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const syncNow = async (s: Source) => {
    setSyncing(s.name)
    setNotice(null)
    setSyncErr(null)
    try {
      const out = await callApi(`/api/sources/sync?name=${encodeURIComponent(s.name)}`, { method: 'POST' })
      const concepts = typeof out.concepts === 'number' ? ` · ${out.concepts} concept${out.concepts === 1 ? '' : 's'}` : ''
      setNotice({ name: s.name, text: `Synced${concepts}` })
      reload()
    } catch (e) {
      setSyncErr({ name: s.name, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSyncing(null)
    }
  }

  if (sources.length === 0) return (
    <div className="cc-sources-empty">
      <div><h2>No sources yet</h2><p>Nothing is feeding the cascade. Add a folder, repository, or MCP server to get started.</p>{live && onAddSource && <button type="button" style={btnSmallPrimary()} onClick={onAddSource}>Add Source</button>}</div>
    </div>
  )

  // The search filter is ignored while reordering: a position only means
  // something against the whole cascade, and moving a row "up" past sources
  // the filter had hidden would be a move the user could not see.
  if (ordered.length === 0 && !reordering) return <div className="cc-sources-empty"><div><h2>No matching sources</h2><p>Try a source name, layer, kind, status, repository, or error message.</p></div></div>

  const reorderTitle = !live
    ? undefined
    : invalid.length > 0
      ? `Remove the invalid ${invalid.length === 1 ? 'entry' : 'entries'} first — the cascade cannot give ${invalid.length === 1 ? 'it' : 'them'} a position: ${invalid.map((source) => source.name).join(', ')}`
      : sources.length < 2
        ? 'Only one source — nothing to reorder'
        : reordering ? 'Back to the source list' : 'Drag sources into the order they should win in'

  return (
    <div className="cc-sources-workspace">
      <div style={css('display:flex; align-items:center; justify-content:space-between; gap:12px;')}>
        <p style={css(`margin:0; font-size:12.5px; line-height:1.5; color:${C.caption};`)}>
          {!live
            ? 'Demo data is read-only. Source management needs the live engine.'
            : reordering
              ? 'Drag a source, or use its arrows. Position 1 wins wherever it speaks. Each move saves right away.'
              : invalid.length > 0
                ? `Select a source to inspect health, metadata, and available actions. Reordering is off until the invalid ${invalid.length === 1 ? 'entry is' : 'entries are'} removed.`
                : sources.length < 2
                  ? 'Select a source to inspect health, metadata, and available actions. Add a second source to choose an order.'
                  : 'Select a source to inspect health, metadata, and available actions.'}
        </p>
        {live && (
          <div style={css('display:flex; gap:8px; flex:0 0 auto;')}>
            <button
              type="button"
              className="cc-h-bd-strong"
              aria-pressed={reordering}
              disabled={!canReorder}
              title={reorderTitle}
              style={!canReorder ? btnSmallDisabled() : reordering ? btnSmallPrimary() : btnSmallGhost()}
              // An open drawer holds a position that a reorder would make
              // stale, so it closes with the mode switch rather than saving
              // a slot the list no longer means.
              onClick={() => { setReordering((on) => !on); setReorderErr(null); setAnnouncement(''); setAwaiting(null); closePanel() }}
            >{reordering ? 'Done' : 'Reorder'}</button>
            {onAddSource && (
              <button type="button" className="cc-h-tealfill2" style={btnSmallPrimary()} onClick={onAddSource}>
                Add Source
              </button>
            )}
          </div>
        )}
      </div>

      {reordering && (
        <div className="cc-source-reorder">
          {normalizedQuery && (
            <p className="cc-source-reorder-note">Showing all {sources.length} sources while reordering — the search filter is off here.</p>
          )}
          <ol aria-label="Cascade order" aria-busy={reorderLocked || undefined}>
            {cascade.map((source, index) => {
              const first = index === 0
              const last = index === cascade.length - 1
              const moving = movingName === source.name
              const drop = dropTarget?.name === source.name ? dropTarget.edge : undefined
              return (
                <li
                  key={source.name}
                  draggable={!reorderLocked}
                  data-dragging={dragName === source.name || undefined}
                  data-drop={drop}
                  onDragStart={onRowDragStart(source.name)}
                  onDragOver={onRowDragOver(source.name)}
                  onDrop={onRowDrop(source.name)}
                  onDragEnd={endDrag}
                  onDragLeave={(event) => {
                    // Only when the pointer really left the row, not moved onto a child.
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => (current?.name === source.name ? null : current))
                  }}
                >
                  <span className="cc-source-grip" aria-hidden="true"><GripIcon /></span>
                  <span className="cc-cascade-rank">{rankLabel(source)}</span>
                  <span className="cc-source-reorder-body">
                    <strong>{source.name}</strong>
                    <small>{moving ? 'Saving…' : `${source.sourceKind} · ${source.status === 'indexing' ? progressLabel(source.indexing) : `${source.conceptCount} concept${source.conceptCount === 1 ? '' : 's'}`}`}</small>
                  </span>
                  {/* Only an END disables an arrow for real. While a move is
                      saving the arrows are held with aria-disabled and the
                      click guard in commitMove — a real `disabled` on the
                      button that has focus would throw focus to the document
                      on every keyboard move. */}
                  <span className="cc-source-reorder-actions">
                    <button
                      ref={registerMoveButton(source.name, 'up')}
                      type="button"
                      className="cc-ui-icon-button"
                      aria-label={`Move ${source.name} up`}
                      aria-disabled={reorderLocked || undefined}
                      title={first ? `${source.name} is already at the top` : `Move ${source.name} up to position ${index}`}
                      disabled={first}
                      onClick={() => void commitMove(source.name, index - 1, 'up')}
                    ><ArrowUpIcon /></button>
                    <button
                      ref={registerMoveButton(source.name, 'down')}
                      type="button"
                      className="cc-ui-icon-button"
                      aria-label={`Move ${source.name} down`}
                      aria-disabled={reorderLocked || undefined}
                      title={last ? `${source.name} is already at the bottom` : `Move ${source.name} down to position ${index + 2}`}
                      disabled={last}
                      onClick={() => void commitMove(source.name, index + 1, 'down')}
                    ><ArrowDownIcon /></button>
                  </span>
                </li>
              )
            })}
          </ol>
          {/* Visible, not screen-reader-only: the moved row lands under a
              hand or a cursor that is looking at the list, and "position 2 of
              3" is the confirmation everyone wants, not just a reader. */}
          <p role="status" aria-live="polite" className="cc-source-reorder-status">{announcement}</p>
          {reorderErr && (
            <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStrokeE}; font-size:11.5px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
              {reorderErr}
            </div>
          )}
        </div>
      )}

      {!reordering && <div ref={detail.containerRef} className="cc-sources-split">
        <div className="cc-source-navigator" role="listbox" aria-label="Sources">
          {ordered.map((source, index) => <button key={source.name} type="button" role="option" aria-selected={source.name === selected?.name} onClick={(event) => selectSource(source.name, event.currentTarget)} onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + ordered.length) % ordered.length
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="option"]')
            selectSource(ordered[next].name, buttons?.[next])
            buttons?.[next]?.focus()
          }}>
            <span aria-hidden="true" style={{ background: statusColor(source.status) }} />
            <span><strong>{source.name}</strong><small>{rowSummary(source)}</small></span>
            <em>{source.status}</em>
          </button>)}
        </div>

        {selected && (() => {
          const s = selected
          const isOpen = panel?.name === s.name
          const editing = isOpen && panel?.kind === 'edit'
          const removing = isOpen && panel?.kind === 'remove'
          const immutable = immutableNote(s)
          return <section ref={detail.panelRef} {...detail.panelProps} className="cc-source-detail" data-open={detailOpen || undefined} aria-label={`Source ${s.name} detail`}>
            <button type="button" className="cc-detail-close" onClick={closeDetail}>Close</button>
            <div className="cc-source-detail-head"><div><div className="cc-source-title"><span aria-hidden="true" style={{ background: statusColor(s.status) }} /><h2>{s.name}</h2>{s.live && <LiveMarker />}</div><div className="cc-source-chips"><LayerChip id={s.layer} /><span>{positionText(s)}</span><span>{s.sourceKind}</span><span>{s.status === 'indexing' ? progressLabel(s.indexing) : `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`}</span>{(s.warnings ?? 0) > 0 && <span title={`${s.warnings} thing${s.warnings === 1 ? '' : 's'} this source could not read`}>{s.warnings} warning{s.warnings === 1 ? '' : 's'}</span>}</div></div><strong>{s.status}</strong></div>

            <ProgressBlock source={s} />

            <dl className="cc-source-metadata">
              <div><dt>Last success</dt><dd>{s.lastSuccessAt ? fmtTime(s.lastSuccessAt) : 'Not yet'}</dd></div>
              <div><dt>Last error</dt><dd>{lastErrorSummary(s)}</dd></div>
              {/* The ONE place the manifest's raw integer shows, for whoever
                  edits manifest.json by hand: everywhere else the app speaks
                  in positions (#1 wins). Not for a quarantined entry, whose
                  level the engine never validated. */}
              {!s.quarantined && <div><dt>Manifest level</dt><dd style={css(`font-family:${MONO}; color:${C.caption};`)}>{s.level} · higher wins</dd></div>}
              {/* "Not supported for this source kind" would be answering the
                  wrong question on an entry that is not a source at all. */}
              {!s.quarantined && <div><dt>Sync</dt><dd>{canSync(s) ? 'Available' : 'Not supported for this source kind'}</dd></div>}
              {!s.quarantined && <div><dt>Files</dt><dd>{filesSummary(s, filesByLayer.get(s.name), fileLayers !== null)}</dd></div>}
              {filesByLayer.get(s.name)?.root && <div><dt>Location</dt><dd style={css(`font-family:${MONO};`)}>{filesByLayer.get(s.name)!.root}</dd></div>}
              {s.origin && <div><dt>Repository</dt><dd>{s.origin}</dd></div>}
            </dl>
            {/* Only where it is still true. A folder-backed source can now be
                repointed from the panel below, so telling its owner to remove
                and re-add would be plain wrong — and an invalid entry has no
                path, repo or command to speak of in the first place. */}
            {!s.quarantined && immutable && <p className="cc-source-immutable">{immutable}</p>}
            {s.quarantined && (
              <div role="alert" style={css(`padding:9px 11px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.55; color:${C.amberText};`)}>
                <strong style={css('display:block; margin-bottom:4px;')}>This entry is not a working source</strong>
                ContextCake could not read it as a valid source, so nothing was built for it and nothing from it reaches the cascade.
                Renaming and syncing have nothing to act on — removing the entry is the fix, and your files are never touched.
              </div>
            )}
            {s.error && (
              <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-family:${MONO}; font-size:11px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                {s.error}
              </div>
            )}

            {/* A source that read successfully but not completely. Its own block
                rather than the error one: nothing is broken, and the row stays
                green — but a folder quietly missing from the cascade is the kind
                of thing you only find out about if it is written down. */}
            {(s.warnings ?? s.warningMessages?.length ?? 0) > 0 && (() => {
              const total = s.warnings ?? s.warningMessages!.length
              const shown = s.warningMessages ?? []
              return (
                <div role="status" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.55; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                  <strong style={css('display:block; margin-bottom:4px;')}>Indexed with {total} thing{total === 1 ? '' : 's'} left out</strong>
                  <ul style={css('margin:0; padding-left:16px;')}>
                    {shown.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                  {total > shown.length && (
                    <span style={css('display:block; margin-top:4px;')}>and {total - shown.length} more — the engine caps this list at {shown.length}.</span>
                  )}
                </div>
              )
            })()}

            <CredentialWarning source={s} />

            {notice?.name === s.name && (
              <div role="status" style={css(`padding:8px 10px; border-radius:8px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-size:11.5px; color:${C.tealText};`)}>
                {notice.text}
              </div>
            )}
            {finder.error && (
              <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                {finder.error}
              </div>
            )}
            {syncErr?.name === s.name && (
              <div role="alert" style={css(`padding:8px 10px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStrokeE}; font-family:${MONO}; font-size:11px; line-height:1.5; color:${C.amberText}; overflow-wrap:anywhere;`)}>
                {syncErr.text}
              </div>
            )}

            {/* Reading is offered in both modes; only the writes below need an
                engine behind them. */}
            {(live || filesByLayer.has(s.name)) && !isOpen && (
              <div style={css('display:flex; gap:8px; flex-wrap:wrap;')}>
                {/* The way in to the navigator. Offered only where there is
                    something to browse — a disabled button over a source that
                    keeps nothing on disk would say less than the Files row
                    above it already does. */}
                {filesByLayer.has(s.name) && (
                  <button
                    type="button"
                    className="cc-h-tealfill2"
                    aria-label={`Browse the files in ${s.name}`}
                    style={btnSmallPrimary()}
                    onClick={() => openFilesScope(s.name)}
                  >Browse files</button>
                )}
                {/* Desktop only — hidden, not disabled, in the browser build. */}
                {live && finder.available && filesByLayer.has(s.name) && (
                  <button
                    type="button"
                    className="cc-h-bd-strong"
                    aria-label={`Reveal the folder for ${s.name} in Finder`}
                    style={btnSmallGhost()}
                    onClick={() => void finder.reveal(s.name, '')}
                  >Reveal in Finder</button>
                )}
                {live && canSync(s) && (
                  <button
                    type="button"
                    className="cc-h-bd-strong"
                    aria-label={`Sync ${s.name} now`}
                    disabled={syncing === s.name}
                    style={syncing === s.name ? btnSmallDisabled() : btnSmallGhost()}
                    onClick={() => void syncNow(s)}
                  >{syncing === s.name ? 'Syncing…' : 'Sync now'}</button>
                )}
                {/* Rename/position writes through the strict manifest path,
                    so on an invalid entry it could only fail. Remove is the
                    one action that goes anywhere from here. */}
                {/* The label names the whole panel, folder included. A control
                    called "Rename / position" over a form that also repoints
                    the source would hide the very thing that pass added — and
                    the visible words have to be inside the accessible name. */}
                {live && !s.quarantined && (
                  <button
                    type="button"
                    className="cc-h-bd-strong"
                    aria-label={canEditPath(s) ? `Rename, reposition or repoint ${s.name}` : `Rename or reposition ${s.name}`}
                    style={btnSmallGhost()}
                    onClick={() => openEdit(s)}
                  >{canEditPath(s) ? 'Rename / position / folder' : 'Rename / position'}</button>
                )}
                {/* The indexing controls (engine-side, session-scoped): a
                    paused source keeps serving its snapshot and reads nothing
                    new; Re-index forces a fresh sweep now. Cancel appears only
                    while a pass is actually running. */}
                {live && canControlIndexing && !s.quarantined && (
                  <>
                    <button
                      type="button"
                      className="cc-h-bd-strong"
                      aria-label={s.indexing?.phase === 'paused' ? `Resume indexing ${s.name}` : `Pause indexing ${s.name}`}
                      disabled={controlling === s.name}
                      style={controlling === s.name ? btnSmallDisabled() : btnSmallGhost()}
                      onClick={() => void runControl(s.indexing?.phase === 'paused' ? 'resume' : 'pause', s.name)}
                    >{s.indexing?.phase === 'paused' ? 'Resume indexing' : 'Pause indexing'}</button>
                    <button
                      type="button"
                      className="cc-h-bd-strong"
                      aria-label={`Re-index ${s.name} now`}
                      disabled={controlling === s.name}
                      style={controlling === s.name ? btnSmallDisabled() : btnSmallGhost()}
                      onClick={() => void runControl('reindex', s.name)}
                    >Re-index</button>
                    {(s.status === 'indexing' || s.indexing?.refreshing === true) && s.indexing?.phase !== 'paused' && (
                      <button
                        type="button"
                        className="cc-h-bd-amber2"
                        aria-label={`Cancel the running index pass for ${s.name}`}
                        disabled={controlling === s.name}
                        style={controlling === s.name ? btnSmallDisabled() : btnSmallGhost()}
                        onClick={() => void runControl('cancel', s.name)}
                      >Cancel pass</button>
                    )}
                  </>
                )}
                {live && <button type="button" className="cc-h-bd-amber2" aria-label={`Remove ${s.name}`} style={btnSmallGhost()} onClick={() => openRemove(s)}>{s.quarantined ? 'Remove entry' : 'Remove'}</button>}
              </div>
            )}

            {editing && (
              <div style={css(`display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.line};`)}>
                <div>
                  <label htmlFor={`src-edit-name`} style={css(`display:block; font-size:12px; font-weight:600; color:${C.body}; margin-bottom:5px;`)}>Source name</label>
                  <input
                    id="src-edit-name"
                    style={css(`width:100%; box-sizing:border-box; padding:9px 11px; border-radius:8px; border:1px solid ${C.line}; background:${C.surface}; color:${C.ink}; font:inherit; font-size:13px;`)}
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setErr(null) }}
                    autoComplete="off"
                  />
                </div>
                {/* The other sources, in cascade order — the select places
                    this one among them. Its own row is left out so "below X"
                    never names itself. Held while an invalid entry exists,
                    for the same reason the Reorder toggle is: the engine
                    refuses to give a quarantined row a position, so the
                    control could only fail. */}
                <CascadePosition
                  id="src-edit-position"
                  value={editPosition}
                  namesAbove={orderNames.filter((name) => name !== s.name)}
                  onChange={(position) => { setEditPosition(position); setErr(null) }}
                  disabled={busy || invalid.length > 0}
                  hint={invalid.length > 0
                    ? `Reordering is off until the invalid ${invalid.length === 1 ? 'entry is' : 'entries are'} removed.`
                    : sources.length > 1
                      ? 'Position 1 wins wherever it speaks. Changing this rewrites the cascade order for every source.'
                      : 'The only source in the cascade — add another to choose an order.'}
                />

                {canEditPath(s) && (
                  <div>
                    <label htmlFor="src-edit-path" style={css(`display:block; font-size:12px; font-weight:600; color:${C.body}; margin-bottom:5px;`)}>Folder</label>
                    <div style={css('display:flex; gap:8px; align-items:center;')}>
                      <input
                        id="src-edit-path"
                        style={css(`flex:1; min-width:0; box-sizing:border-box; padding:9px 11px; border-radius:8px; border:1px solid ${C.line}; background:${C.surface}; color:${C.ink}; font-family:${MONO}; font-size:12px;`)}
                        value={editPath}
                        onChange={(e) => { setEditPath(e.target.value); setErr(null) }}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {window.__CC_DESKTOP?.chooseFolder && (
                        <button
                          type="button"
                          className="cc-h-bd-strong"
                          style={{ ...btnSmallGhost(), flex: '0 0 auto' }}
                          onClick={() => void window.__CC_DESKTOP?.chooseFolder?.().then((chosen) => {
                            if (chosen) { setEditPath(chosen); setErr(null) }
                          })}
                        >Choose…</button>
                      )}
                    </div>
                  </div>
                )}

                <p style={css(`margin:0; font-size:11.5px; line-height:1.5; color:${C.caption};`)}>
                  {canEditPath(s)
                    ? 'Pointing this source at a different folder re-reads it from scratch. Your files are never moved or copied.'
                    : immutableNote(s)}
                </p>
                {s.live && <LiveWarning verb="Renaming" />}
                {err && <p role="alert" style={css(`margin:0; font-size:12px; color:${C.amberText}; overflow-wrap:anywhere;`)}>{err}</p>}
                <div style={css('display:flex; justify-content:flex-end; gap:8px;')}>
                  <button type="button" style={btnSmallGhost()} onClick={closePanel}>Cancel</button>
                  <button type="button" disabled={busy} style={busy ? btnSmallDisabled() : btnSmallPrimary()} onClick={() => void saveEdit(s)}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {removing && (() => {
              // Any removal takes the invalid entries with it: the engine
              // writes a manifest only when the whole thing validates, so
              // leaving one behind refuses the write — including a write that
              // was only meant to remove a healthy source. The panel names them
              // before the click rather than removing rows the user did not
              // choose.
              const others = alsoInvalid(s)
              return (
                <div style={css(`display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.amberStroke};`)}>
                  <p style={css(`margin:0; font-size:12.5px; line-height:1.5; color:${C.body};`)}>
                    {s.quarantined
                      ? <>Remove the invalid entry <strong style={css(`font-family:${MONO};`)}>{s.name}</strong> from your manifest? Your files stay where they are — nothing was being read from this entry.</>
                      : <>Remove <strong style={css(`font-family:${MONO};`)}>{s.name}</strong> from the cascade? Your files stay where they are — only the cascade entry is removed.</>}
                  </p>
                  {others.length > 0 && (
                    <div role="alert" style={css(`padding:9px 11px; border-radius:8px; background:${C.amberFill}; border:1px solid ${C.amberStroke}; font-size:11.5px; line-height:1.55; color:${C.amberText};`)}>
                      <strong style={css('display:block; margin-bottom:4px;')}>
                        {others.length === 1 ? 'One other entry is also invalid' : `${others.length} other entries are also invalid`}
                      </strong>
                      Your manifest can only be saved once every invalid entry is gone, so this also removes{' '}
                      {others.length === 1 ? 'it' : 'them'}:{' '}
                      <span style={css(`font-family:${MONO};`)}>{others.map((source) => source.name).join(', ')}</span>
                    </div>
                  )}
                  {s.live && <LiveWarning verb="Removing" />}
                  {err && <p role="alert" style={css(`margin:0; font-size:12px; color:${C.amberText}; overflow-wrap:anywhere;`)}>{err}</p>}
                  <div style={css('display:flex; justify-content:flex-end; gap:8px;')}>
                    <button type="button" style={btnSmallGhost()} onClick={closePanel}>Cancel</button>
                    <button type="button" disabled={busy} style={busy ? btnSmallDisabled() : btnSmallDanger()} onClick={() => void confirmRemove(s)}>
                      {busy
                        ? 'Removing…'
                        : others.length > 0
                          ? `Remove ${others.length + 1} entries`
                          : s.quarantined ? 'Remove entry' : 'Remove source'}
                    </button>
                  </div>
                </div>
              )
            })()}
          </section>
        })()}
      </div>}
    </div>
  )
}


/**
 * Deliberately NOT wrapped in React.memo, unlike its sibling views. A memoized
 * component with no props only ever re-renders from a context it subscribes to,
 * and this view's suite drives updates by mutating a module-scoped store mock
 * and re-rendering the same element — with a memo in the way those renders are
 * skipped and the tests silently stop exercising anything. Those are the tests
 * that hold the navigator's focus guarantee and its DOM-order invariant, and
 * the memo would only save renders caused by the shell's own local state.
 */
