// Sources view: manage the layers feeding the cascade — rename, re-level,
// repoint, sync, and remove ride the engine's source API (PATCH/DELETE
// /api/sources, POST /api/sources/sync). A folder-backed source can be pointed
// at a different folder in place; a repo or an MCP command genuinely can't be,
// and the UI says which case you are in rather than telling everyone to remove
// and re-add. Errors render verbatim — including the engine's pack-invariant
// messages — never paraphrased into vagueness.
// Demo mode shows the same rows read-only.
import { useEffect, useMemo, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { apiFetch, progressLabel, progressPercent } from '../api'
import { LayerChip } from '../components/LayerChip'
import { LevelStepper } from '../components/SetupWizard'
import { useDetailSurface } from '../components/useDetailSurface'
import { filesRevalidation, useLayerFiles } from '../layer-files'
import { useReveal } from '../reveal'
import { useStore } from '../store'
import type { Source } from '../data'
import type { LayerFiles } from '../types'

// Sync of a clone-backed source runs `git pull` server-side (bounded at 120s
// there) — same headroom as the wizard's mutations.
const MUTATION_TIMEOUT_MS = 150_000

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
 * What a row says under the name. A source mid-index has no concept count worth
 * quoting — "0 concepts" next to a green "synced" was the app claiming to be
 * finished with work it had barely started.
 */
function rowSummary(s: Source): string {
  const base = `${s.sourceKind} · level ${s.level}`
  if (s.status === 'indexing') return `${base} · ${progressLabel(s.indexing)}`
  const count = `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`
  return `${base} · ${count}${s.indexing?.refreshing ? ' · refreshing' : ''}`
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
      style={css(`display:inline-flex; align-items:center; gap:5px; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:${C.amberFill}; color:${C.amberText}; border:1px solid ${C.amberStroke};`)}
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
  const { mode, sources, reload, reloadKey, query, openFilesScope } = useStore()
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
  const [editLevel, setEditLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ name: string; text: string } | null>(null)
  const [syncErr, setSyncErr] = useState<{ name: string; text: string } | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const selectedButton = useRef<HTMLButtonElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)

  const normalizedQuery = (query ?? '').trim().toLowerCase()
  const ordered = [...sources]
    .filter((source) => !normalizedQuery || [
      source.name,
      source.layer,
      source.sourceKind,
      source.status,
      source.error,
      source.origin,
    ].some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery)))
    .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))

  // Every invalid manifest entry, off the unfiltered list: what a repair has to
  // clear is a property of the manifest, not of what the search box is showing.
  const invalid = sources.filter((source) => source.quarantined)
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

  const openEdit = (s: Source) => {
    setPanel({ name: s.name, kind: 'edit' })
    setEditName(s.name)
    setEditPath(filesByLayer.get(s.name)?.root ?? '')
    setEditLevel(s.level)
    setErr(null)
  }
  const openRemove = (s: Source) => { setPanel({ name: s.name, kind: 'remove' }); setErr(null) }
  const closePanel = () => { setPanel(null); setErr(null) }

  const saveEdit = async (s: Source) => {
    const newName = editName.trim()
    if (!newName) { setErr('Give this source a short name.'); return }
    const currentRoot = filesByLayer.get(s.name)?.root ?? ''
    const newPath = editPath.trim()
    const body: Record<string, unknown> = { name: s.name }
    if (newName !== s.name) body.newName = newName
    if (editLevel !== s.level) body.level = editLevel
    // Only a real move is sent. An untouched field must not re-key the index
    // entry and put a settled source back through a full read for nothing.
    if (canEditPath(s) && newPath && newPath !== currentRoot) body.path = newPath
    if (body.newName === undefined && body.level === undefined && body.path === undefined) { closePanel(); return }
    setBusy(true)
    setErr(null)
    try {
      const out = await callApi('/api/sources', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
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
      }
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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

  if (ordered.length === 0) return <div className="cc-sources-empty"><div><h2>No matching sources</h2><p>Try a source name, layer, kind, status, repository, or error message.</p></div></div>

  return (
    <div className="cc-sources-workspace">
      <div style={css('display:flex; align-items:center; justify-content:space-between; gap:12px;')}>
        <p style={css(`margin:0; font-size:12.5px; line-height:1.5; color:${C.caption};`)}>
          {live
            ? 'Select a source to inspect health, metadata, and available actions.'
            : 'Demo data is read-only. Source management needs the live engine.'}
        </p>
        {live && onAddSource && (
          <button type="button" className="cc-h-tealfill2" style={{ ...btnSmallPrimary(), flex: '0 0 auto' }} onClick={onAddSource}>
            Add Source
          </button>
        )}
      </div>

      <div ref={detail.containerRef} className="cc-sources-split">
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
            <div className="cc-source-detail-head"><div><div className="cc-source-title"><span aria-hidden="true" style={{ background: statusColor(s.status) }} /><h2>{s.name}</h2>{s.live && <LiveMarker />}</div><div className="cc-source-chips"><LayerChip id={s.layer} /><span>level {s.level}</span><span>{s.sourceKind}</span><span>{s.status === 'indexing' ? progressLabel(s.indexing) : `${s.conceptCount} concept${s.conceptCount === 1 ? '' : 's'}`}</span>{(s.warnings ?? 0) > 0 && <span title={`${s.warnings} thing${s.warnings === 1 ? '' : 's'} this source could not read`}>{s.warnings} warning{s.warnings === 1 ? '' : 's'}</span>}</div></div><strong>{s.status}</strong></div>

            <ProgressBlock source={s} />

            <dl className="cc-source-metadata">
              <div><dt>Last success</dt><dd>{s.lastSuccessAt ? fmtTime(s.lastSuccessAt) : 'Not yet'}</dd></div>
              <div><dt>Last error</dt><dd>{s.lastErrorAt ? fmtTime(s.lastErrorAt) : 'None'}</dd></div>
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
                {/* Rename/level writes through the strict manifest path, so on
                    an invalid entry it could only fail. Remove is the one
                    action that goes anywhere from here. */}
                {/* The label names the whole panel, folder included. A control
                    called "Rename / level" over a form that also repoints the
                    source would hide the very thing this pass added — and the
                    visible words have to be inside the accessible name. */}
                {live && !s.quarantined && (
                  <button
                    type="button"
                    className="cc-h-bd-strong"
                    aria-label={canEditPath(s) ? `Rename, re-level or repoint ${s.name}` : `Rename or re-level ${s.name}`}
                    style={btnSmallGhost()}
                    onClick={() => openEdit(s)}
                  >{canEditPath(s) ? 'Rename / level / folder' : 'Rename / level'}</button>
                )}
                {live && <button type="button" className="cc-h-bd-amber2" aria-label={`Remove ${s.name}`} style={btnSmallGhost()} onClick={() => openRemove(s)}>{s.quarantined ? 'Remove entry' : 'Remove'}</button>}
              </div>
            )}

            {editing && (
              <div style={css(`display:flex; flex-direction:column; gap:10px; padding:12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.line};`)}>
                <div style={css('display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:start;')}>
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
                  <LevelStepper id="src-edit-level" value={editLevel} onChange={setEditLevel} />
                </div>

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
      </div>
    </div>
  )
}
