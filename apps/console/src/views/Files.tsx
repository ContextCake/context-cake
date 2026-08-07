// Files view: the context files behind each source, browsable and editable.
//
// This is the answer to "what can I do while the cascade indexes" — file
// listing is cheap, so this view is useful immediately, even while sources are
// still being read. Markdown opens rendered by default with a Raw tab for the
// actual .md source (frontmatter, OKF heading attrs and all).
//
// The demo runs the same navigator over a build-time snapshot of the engine's
// file APIs (layer-files.ts): same tree, same documents, same file ⇄ concept
// links, and no way to save. Editing is the one thing a snapshot cannot honour,
// so the demo drops the affordance rather than accepting a keystroke it would
// have to throw away.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { C, css, lc, MONO, type LayerId } from '../theme'
import { apiFetch } from '../api'
import type { Concept } from '../data'
import { buildTree, FileTree } from '../components/FileTree'
import { Markdown } from '../components/Markdown'
import { useDetailSurface } from '../components/useDetailSurface'
import { filesRevalidation, readLayerFile, useLayerFiles } from '../layer-files'
import { useReveal } from '../reveal'
import { useStoreData, useStoreInput, useStoreNav } from '../store'
import type { FileContent, LayerFile } from '../types'

type Tab = 'rendered' | 'raw'

/** Extensions the cascade reads as documents — a concept id is the rel minus one of these. */
const DOC_EXT = /\.(md|markdown|mdx|txt)$/i

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={css('display:grid; place-items:center; height:100%; padding:32px; text-align:center;')}>
      <div style={css('max-width:380px; display:flex; flex-direction:column; gap:8px;')}>
        <strong style={css(`font-size:14px; color:${C.ink};`)}>{title}</strong>
        <span style={css(`font-size:12.5px; line-height:1.55; color:${C.caption};`)}>{detail}</span>
      </div>
    </div>
  )
}

/** An in-place explanation for the navigator column — it keeps the tree's frame. */
function NavigatorNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={css('padding:14px 12px; display:flex; flex-direction:column; gap:6px;')}>
      <strong style={css(`font-size:12px; color:${C.ink};`)}>{title}</strong>
      <span style={css(`font-size:11.5px; line-height:1.55; color:${C.caption};`)}>{children}</span>
    </div>
  )
}

/** Rows, not a spinner: the shape of what is coming is itself information. */
function TreeSkeleton() {
  return (
    <>
      <span className="sr-only" role="status">Reading the files behind your sources…</span>
      <div aria-hidden="true" style={css('padding:12px 10px; display:flex; flex-direction:column; gap:10px;')}>
        {[92, 64, 78, 54, 84, 60, 72, 50].map((width, index) => (
          <span
            key={width * 100 + index}
            style={css(`height:9px; width:${width}%; border-radius:5px; background:${C.track}; animation:ccPulse 1.5s ease-in-out ${index * 0.09}s infinite;`)}
          />
        ))}
      </div>
    </>
  )
}

/**
 * Why a source the user can plainly see in Sources owns no files here.
 * `/api/files` covers layers with a folder on disk; a remote graph or a repo
 * read over the API is legitimately absent, and saying so is the difference
 * between an explanation and a view that looks broken.
 */
function absentReason(kind: string | undefined): string {
  if (kind === 'mcp') return 'This source serves a remote knowledge graph over MCP. ContextCake reads it live, so there are no local files to browse or edit — its concepts are in Knowledge → Concepts.'
  if (kind === 'github') return 'This repository is read through the GitHub API without a clone, so nothing from it is stored on this machine. Its documents are in Knowledge → Concepts.'
  return 'This source has no folder on disk, so there are no files to browse. Its content is in Knowledge → Concepts.'
}

/**
 * The concept a document file resolves to, if any.
 *
 * A concept id is a file's path inside its layer with the document extension
 * taken off — the same derivation the engine's adapters make, which is why the
 * link can be drawn without asking the server anything. A file that matches no
 * concept gets no strip: the cascade genuinely does not read it (a note under
 * the size cap, an asset, a file added since the last index).
 */
function conceptForFile(file: FileContent | null, concepts: Concept[]): { concept: Concept; conflicts: number } | null {
  if (!file || !DOC_EXT.test(file.ext)) return null
  const id = file.rel.replace(DOC_EXT, '')
  const concept = concepts.find((candidate) => candidate.id === id)
  if (!concept) return null
  return { concept, conflicts: concept.sections.filter((s) => (s.dissents?.length ?? 0) > 0).length }
}

export function Files() {
  const { mode, concepts, sources, reload, reloadKey, setFilesScope, setFilesPath, openConcept } = useStoreData()
  const { filesScope, filesPath } = useStoreNav()
  const { query } = useStoreInput()
  const [file, setFile] = useState<FileContent | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('rendered')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const navigatorRef = useRef<HTMLElement | null>(null)
  const detail = useDetailSurface<HTMLDivElement, HTMLElement>(detailOpen)
  const finder = useReveal()

  const live = mode === 'live'
  const selected = filesPath
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  // Saving needs a file the engine will take a write for AND an engine to take
  // it: the demo has the document but no write route behind it.
  const canEdit = live && file?.editable === true
  const dirty = canEdit && file?.text !== undefined && draft !== file.text

  // The listing is cheap even mid-index, so it loads on its own and doesn't
  // wait for the cascade. It re-runs when the source set changes.
  const { layers, error: listError } = useLayerFiles(mode, filesRevalidation(sources, reloadKey))

  // Which source each layer belongs to, for the layer-coloured root rows. The
  // hues are product semantics (personal amber / team teal / company indigo),
  // reused here rather than reinvented.
  const layerIds = useMemo(() => {
    const map = new Map<string, LayerId>()
    for (const source of sources) map.set(source.name, source.layer)
    return map
  }, [sources])

  const scopedLayers = useMemo(
    () => (layers ?? []).filter((layer) => !filesScope || layer.layer === filesScope),
    [layers, filesScope],
  )
  const allFiles = useMemo(() => scopedLayers.flatMap((l) => l.files), [scopedLayers])

  // Open the first markdown file once, so the view never opens blank.
  const autoOpened = useRef<string | null>(null)
  useEffect(() => {
    if (selected || allFiles.length === 0) return
    const first = (allFiles.find((f: LayerFile) => f.markdown) ?? allFiles[0]).path
    autoOpened.current = first
    setFilesPath(first)
  }, [allFiles, selected, setFilesPath])

  // Which selection the tree should open folders for. A file the user asked for
  // — clicked, or named in the URL — reveals itself. The one the view opened on
  // its own must not: on a 3,000-note vault that expanded two levels and buried
  // the folder overview under 250 siblings before the user had done anything.
  const reveal = selected && selected !== autoOpened.current ? selected : null

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void (async () => {
      try {
        const data = await readLayerFile(mode, selected)
        if (cancelled) return
        setFile(data)
        setDraft(data.text ?? '')
        setTab(data.markdown ? 'rendered' : 'raw')
        setFileError(null)
        setSavedAt(null)
      } catch (e) {
        if (cancelled) return
        setFile(null)
        setFileError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [mode, selected])

  // Images and PDFs must be fetched through apiFetch so the desktop bearer is
  // present; putting /api/file/raw directly in src would 401 inside the app.
  // Object URLs let authenticated responses feed inert image/PDF containers
  // without putting the bearer in a URL.
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setPreviewUrl(null)
    setPreviewError(null)
    if (!file || (file.kind !== 'image' && file.kind !== 'pdf')) return undefined
    // The demo snapshot carries text, not bytes: there is no /api/file/raw to
    // ask, and asking anyway would leave the pane on "Loading preview…" for
    // good. The render says so instead.
    if (!live) return undefined
    void (async () => {
      try {
        const res = await apiFetch(`/api/file/raw?path=${encodeURIComponent(file.path)}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}) as { error?: string })
          throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
        }
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const guardNavigation = (event: Event) => {
      if (!window.confirm(`Discard unsaved changes to ${file?.path ?? 'this file'}?`)) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener('contextcake:before-navigate', guardNavigation)
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('contextcake:before-navigate', guardNavigation)
    }
  }, [dirty, file?.path])

  const chooseFile = useCallback((path: string) => {
    if (path === selectedRef.current) { setDetailOpen(true); return }
    if (dirty && !window.confirm(`Discard unsaved changes to ${file?.path ?? 'this file'}?`)) return
    setFilesPath(path)
    setDetailOpen(true)
  }, [dirty, file?.path, setFilesPath])

  // Focus goes back to the tree, not to a remembered node: the row that opened
  // the sheet may have been windowed out while the sheet was up.
  const closeDetail = useCallback(() => {
    setDetailOpen(false)
    requestAnimationFrame(() => {
      const tree = navigatorRef.current
      const row = tree?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
        ?? tree?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
      row?.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    if (!detailOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDetail() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDetail, detailOpen])

  const save = useCallback(async () => {
    if (!file || !dirty || saving) return
    const savePath = file.path
    const saveDraft = draft
    setSaving(true)
    setFileError(null)
    try {
      const res = await apiFetch('/api/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: savePath, text: saveDraft, modified: file.modified }),
      })
      const data = await res.json().catch(() => ({}) as { error?: string; modified?: string })
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
      if (selectedRef.current === savePath) {
        setFile((current) => current?.path === savePath
          ? { ...current, text: saveDraft, modified: (data as { modified?: string }).modified ?? current.modified }
          : current)
        setSavedAt(new Date().toLocaleTimeString())
      }
      reload() // the cascade changed — re-resolve so every other view agrees
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [file, dirty, draft, saving, reload])

  // ⌘S / Ctrl+S saves, the shortcut everyone tries in an editor. Not bound where
  // there is nothing to save: swallowing the browser's own ⌘S over a read-only
  // demo would take a shortcut away and give nothing back.
  useEffect(() => {
    if (!canEdit) return undefined
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, save])

  if (listError) {
    return <Empty title="Couldn't list your files" detail={listError} />
  }
  if (layers && layers.length === 0) {
    return <Empty title="No source keeps files on this machine" detail="Point a source at a folder — a ContextCake bundle or any folder of Markdown — and its files appear here to browse and edit. Sources read over MCP or the GitHub API have nothing stored locally, so they never appear in this view." />
  }

  const normalizedQuery = (query ?? '').trim().toLowerCase()
  const matching = (files: LayerFile[], layer: string) => {
    if (!normalizedQuery) return files
    if (layer.toLowerCase().includes(normalizedQuery)) return files
    return files.filter((fileEntry) => [fileEntry.path, fileEntry.name, fileEntry.rel]
      .some((value) => value.toLowerCase().includes(normalizedQuery)))
  }
  const visibleLayers = scopedLayers
    .map((layer) => ({ ...layer, files: matching(layer.files, layer.layer) }))
    .filter((layer) => !normalizedQuery || layer.files.length > 0)
  const entries = buildTree(visibleLayers)
  const scopeSource = filesScope ? sources.find((s) => s.name === filesScope) : undefined
  // Scoped at a source `/api/files` never listed: it owns no folder on disk.
  const scopeAbsent = Boolean(filesScope) && layers !== null && !layers.some((l) => l.layer === filesScope)
  const truncated = visibleLayers.filter((layer) => layer.truncated)
  const scopeColor = filesScope ? lc(layerIds.get(filesScope) ?? 'team') : null
  const resolved = conceptForFile(file, concepts)

  return (
    <div ref={detail.containerRef} className="cc-files-workspace" style={css('display:grid; grid-template-columns:minmax(220px, 300px) minmax(0, 1fr); gap:0; height:100%; min-height:0;')}>
      <aside
        ref={navigatorRef}
        className="cc-files-navigator"
        style={css(`display:flex; flex-direction:column; min-height:0; border-right:1px solid ${C.line}; background:${C.surface};`)}
      >
        {filesScope && (
          <div className="cc-files-scope">
            <span className="cc-scope-chip">
              {scopeColor && <span aria-hidden="true" style={css(`width:6px; height:6px; border-radius:999px; background:${scopeColor.strokeE};`)} />}
              <strong>{filesScope}</strong>
              <button
                type="button"
                aria-label={`Stop showing only ${filesScope} — browse files from every source`}
                title="Show every source"
                onClick={() => setFilesScope(null)}
              >×</button>
            </span>
            {!scopeAbsent && (
              <span className="cc-scope-meta" title={scopedLayers[0]?.root}>
                {scopedLayers[0]?.fileCount ?? 0} file{scopedLayers[0]?.fileCount === 1 ? '' : 's'}
                {scopedLayers[0]?.root ? ` · ${scopedLayers[0].root}` : ''}
              </span>
            )}
          </div>
        )}

        {truncated.map((layer) => (
          <p key={layer.layer} role="status" style={css(`margin:0; padding:7px 10px; font-size:11px; line-height:1.45; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; color:var(--cc-amber-text);`)}>
            {layer.layer}: showing the first {layer.fileCount} files — raise the scan limit in Settings to list more.
          </p>
        ))}

        {layers === null ? (
          <TreeSkeleton />
        ) : scopeAbsent ? (
          <NavigatorNote title={`${filesScope} keeps no files here`}>
            {absentReason(scopeSource?.sourceKind)}
          </NavigatorNote>
        ) : entries.length === 0 && normalizedQuery ? (
          <NavigatorNote title="Nothing matches that">
            No file name or path {filesScope ? `in ${filesScope} ` : ''}contains “{query}”. Clear the search to see the whole tree
            {filesScope ? ', or clear the source filter above' : ''}.
          </NavigatorNote>
        ) : entries.length === 0 || allFiles.length === 0 ? (
          <NavigatorNote title="This folder is empty">
            ContextCake found no readable files in {filesScope ?? 'this source'}. Add a Markdown note and it appears here — the index picks it up on its own.
          </NavigatorNote>
        ) : (
          <FileTree
            entries={entries}
            expandAll={Boolean(normalizedQuery)}
            selected={selected}
            reveal={reveal}
            onSelect={chooseFile}
            layerIds={layerIds}
            label={filesScope ? `Files in ${filesScope}` : 'Files by source'}
          />
        )}
      </aside>

      <section ref={detail.panelRef} {...detail.panelProps} aria-label={file ? `${file.path} file detail` : 'File detail'} className="cc-files-detail" data-open={detailOpen || undefined} style={css('display:flex; flex-direction:column; min-height:0; min-width:0;')}>
        <button type="button" className="cc-detail-close" onClick={closeDetail}>Close</button>
        {!file && !fileError && <Empty title="Select a file" detail="Pick a file on the left to read or edit it." />}
        {fileError && !file && <Empty title="Couldn't open that file" detail={fileError} />}
        {file && (
          <>
            <header style={css(`display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid ${C.line};`)}>
              <div style={css('min-width:0; flex:1;')}>
                <div style={css(`font-family:${MONO}; font-size:12.5px; font-weight:600; color:${C.ink}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`)}>{file.path}</div>
                <div style={css(`font-size:11px; color:${C.caption};`)}>
                  {(file.bytes / 1024).toFixed(1)} KB · edited {new Date(file.modified).toLocaleString()}
                  {savedAt && !dirty && <span style={css(`color:${C.tealText};`)}> · saved {savedAt}</span>}
                  {dirty && <span style={css('color:var(--cc-amber-text);')}> · unsaved changes</span>}
                  {/* Where the Save button would be, an honest reason it isn't. */}
                  {!live && <span title="The demo runs from a build-time snapshot of a real folder."> · read-only in the demo</span>}
                </div>
              </div>

              {file.markdown && (
                <div role="group" aria-label="View mode" style={css(`display:flex; gap:2px; padding:2px; border-radius:8px; background:${C.surface}; border:1px solid ${C.line};`)}>
                  {(['rendered', 'raw'] as Tab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={tab === t}
                      onClick={() => setTab(t)}
                      style={css(`padding:5px 11px; border:none; border-radius:6px; cursor:pointer; font:inherit; font-size:12px; font-weight:600; text-transform:capitalize; background:${tab === t ? C.tealFill : 'transparent'}; color:${tab === t ? C.tealText : C.caption};`)}
                    >{t}</button>
                  ))}
                </div>
              )}

              {/* Desktop only, and absent rather than disabled elsewhere: the
                  web build has no Finder to reveal anything in. */}
              {finder.available && (
                <button
                  type="button"
                  className="cc-h-bd-strong"
                  aria-label={`Reveal ${file.rel} in Finder`}
                  onClick={() => void finder.reveal(file.layer, file.rel)}
                  style={css(`padding:7px 12px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; font-weight:600; border:1px solid ${C.line}; background:transparent; color:${C.caption};`)}
                >Reveal in Finder</button>
              )}

              {canEdit && (
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  style={css(`padding:7px 14px; border-radius:8px; cursor:${!dirty || saving ? 'not-allowed' : 'pointer'}; font:inherit; font-size:12px; font-weight:600; border:1px solid ${dirty ? C.tealStroke : C.line}; background:${dirty ? C.tealFill : C.neutralFill}; color:${dirty ? C.tealText : C.faint};`)}
                >{saving ? 'Saving…' : 'Save'}</button>
              )}
            </header>

            {/* What this file becomes in the cascade. The point of the whole
                view is that files and concepts are two ends of one thing, and
                until now you could only walk it in one direction. */}
            {resolved && (
              <div style={css(`display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 16px; border-bottom:1px solid ${C.line}; background:${C.surface};`)}>
                <span style={css(`font-size:10px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:${C.faint};`)}>Resolves to</span>
                <button
                  type="button"
                  className="cc-h-bd-strong"
                  aria-label={`Open the concept ${resolved.concept.title} in Knowledge`}
                  onClick={() => openConcept(resolved.concept.id)}
                  style={css(`display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid ${C.line}; border-radius:999px; background:${C.raised}; cursor:pointer; font:inherit; font-size:12px; font-weight:600; color:${C.ink};`)}
                >
                  {resolved.concept.title}
                  <code style={css(`font-family:${MONO}; font-size:10.5px; font-weight:500; color:${C.caption};`)}>{resolved.concept.id}</code>
                </button>
                {/* Icon + words, never the amber alone — the same "conflict"
                    marker the canvas node uses. */}
                {resolved.conflicts > 0 && (
                  <span style={css(`display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600; color:${C.amberText};`)}>
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                    {resolved.conflicts} conflict{resolved.conflicts === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            )}

            {fileError && (
              <p role="alert" style={css(`margin:0; padding:8px 16px; font-size:12px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; color:var(--cc-amber-text);`)}>{fileError}</p>
            )}
            {finder.error && (
              <p role="alert" style={css(`margin:0; padding:8px 16px; font-size:12px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; color:var(--cc-amber-text);`)}>{finder.error}</p>
            )}

            <div style={css('flex:1; min-height:0; overflow:auto;')}>
              {!file.editable && (file.kind === 'image' || file.kind === 'pdf') ? (
                !live ? (
                  <Empty
                    title="Not in the demo snapshot"
                    detail="The demo carries the text of each document, not its bytes, so this one is listed but not rendered. Open ContextCake with your own folder to preview images and PDFs."
                  />
                ) : previewError ? (
                  <Empty title="Couldn't preview this file" detail={previewError} />
                ) : previewUrl ? (
                  file.kind === 'image'
                    ? <img src={previewUrl} alt={file.path} style={css('display:block; max-width:100%; max-height:100%; margin:auto; object-fit:contain; padding:20px; box-sizing:border-box;')} />
                    : <iframe sandbox="" src={previewUrl} title={`Preview ${file.path}`} style={css('display:block; width:100%; height:100%; min-height:420px; border:0;')} />
                ) : (
                  <Empty title="Loading preview…" detail="ContextCake is reading this file from its source folder." />
                )
              ) : !file.editable ? (
                <Empty
                  title="Not editable here"
                  detail={file.reason ?? 'This file type is stored alongside your notes but is not text ContextCake can edit.'}
                />
              ) : tab === 'rendered' && file.markdown ? (
                <div style={css('padding:20px 24px; max-width:74ch;')}>
                  <Markdown source={draft} className="cc-md" />
                </div>
              ) : (
                <textarea
                  ref={editorRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  readOnly={!canEdit}
                  aria-label={canEdit ? `Edit ${file.path}` : `${file.path}, read-only`}
                  style={css(`display:block; width:100%; height:100%; min-height:340px; box-sizing:border-box; padding:20px 24px; border:none; resize:none; outline:none; background:transparent; color:${C.ink}; font-family:${MONO}; font-size:12.5px; line-height:1.7; tab-size:2;`)}
                />
              )}
            </div>
          </>
        )}
      </section>
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
