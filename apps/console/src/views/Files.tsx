// Files view: the context files behind each source, browsable and editable.
//
// This is the answer to "what can I do while the cascade indexes" — file
// listing is cheap, so this view is useful immediately, even while sources are
// still being read. Markdown opens rendered by default with a Raw tab for the
// actual .md source (frontmatter, OKF heading attrs and all).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { C, css, MONO } from '../theme'
import { apiFetch } from '../api'
import { Markdown } from '../components/Markdown'
import { useStore } from '../store'
import type { FileContent, LayerFile, LayerFiles } from '../types'

type Tab = 'rendered' | 'raw'

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { headers: { accept: 'application/json' } })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return data as T
}

function fileLabel(file: LayerFile): string {
  return file.rel.includes('/') ? file.rel : file.name
}

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

export function Files() {
  const { mode, sources, reload } = useStore()
  const [layers, setLayers] = useState<LayerFiles[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('rendered')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const live = mode === 'live'
  const dirty = file?.text !== undefined && draft !== file.text

  // The file list is cheap even mid-index, so it loads on its own and doesn't
  // wait for the cascade. It re-runs when the source set changes.
  useEffect(() => {
    if (!live) return
    let cancelled = false
    void (async () => {
      try {
        const data = await getJson<{ layers: LayerFiles[] }>('/api/files')
        if (cancelled) return
        setLayers(data.layers)
        setListError(null)
      } catch (e) {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [live, sources.length])

  const allFiles = useMemo(
    () => (layers ?? []).flatMap((l) => l.files.map((f) => ({ ...f, layer: l.layer }))),
    [layers],
  )

  // Open the first markdown file once, so the view never opens blank.
  useEffect(() => {
    if (selected || allFiles.length === 0) return
    setSelected((allFiles.find((f) => f.markdown) ?? allFiles[0]).path)
  }, [allFiles, selected])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void (async () => {
      try {
        const data = await getJson<FileContent>(`/api/file?path=${encodeURIComponent(selected)}`)
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
  }, [selected])

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

  const chooseFile = (path: string) => {
    if (path === selected) return
    if (dirty && !window.confirm(`Discard unsaved changes to ${file?.path ?? 'this file'}?`)) return
    setSelected(path)
  }

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

  // ⌘S / Ctrl+S saves, the shortcut everyone tries in an editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  if (!live) {
    return <Empty title="Files are a live-mode view" detail="Open ContextCake with your own sources to browse and edit the files behind each layer. The demo uses a build-time snapshot with no files on disk." />
  }
  if (listError) {
    return <Empty title="Couldn't list your files" detail={listError} />
  }
  if (layers && layers.length === 0) {
    return <Empty title="No file-backed sources yet" detail="Markdown folders and ContextCake folders show their files here. An MCP source serves a remote graph, so it has no local files to edit." />
  }

  const visible = (files: LayerFile[]) => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }

  return (
    <div style={css('display:grid; grid-template-columns:minmax(220px, 280px) minmax(0, 1fr); gap:0; height:100%; min-height:0;')}>
      <aside style={css(`display:flex; flex-direction:column; min-height:0; border-right:1px solid ${C.line}; background:${C.surface};`)}>
        <div style={css(`padding:12px 12px 10px; border-bottom:1px solid ${C.line};`)}>
          <label htmlFor="cc-files-filter" className="sr-only">Filter files</label>
          <input
            id="cc-files-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            autoComplete="off"
            style={css(`width:100%; box-sizing:border-box; padding:7px 10px; border-radius:8px; border:1px solid ${C.line}; background:${C.raised}; color:${C.ink}; font:inherit; font-size:12.5px;`)}
          />
        </div>
        <div style={css('flex:1; min-height:0; overflow-y:auto; padding:8px;')}>
          {layers === null ? (
            <p style={css(`margin:8px; font-size:12px; color:${C.caption};`)}>Loading files…</p>
          ) : layers.map((layer) => {
            const files = visible(layer.files)
            return (
              <section key={layer.layer} style={css('margin-bottom:12px;')}>
                <header style={css('display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding:4px 6px;')}>
                  <strong style={css(`font-size:11.5px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:${C.caption};`)}>{layer.layer}</strong>
                  <span style={css(`font-size:11px; color:${C.faint};`)}>{layer.fileCount}</span>
                </header>
                {layer.truncated && (
                  <p style={css(`margin:0 6px 6px; font-size:11px; line-height:1.45; color:var(--cc-amber-text);`)}>
                    Showing the first {layer.fileCount} files — raise the scan limit in Settings to list more.
                  </p>
                )}
                {files.length === 0 ? (
                  <p style={css(`margin:0 6px; font-size:11.5px; color:${C.faint};`)}>No matching files.</p>
                ) : files.map((f) => {
                  const active = f.path === selected
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => chooseFile(f.path)}
                      aria-current={active ? 'true' : undefined}
                      title={f.path}
                      style={css(`display:block; width:100%; text-align:left; padding:6px 8px; margin-bottom:2px; border:none; border-radius:7px; cursor:pointer; font:inherit; font-family:${MONO}; font-size:11.5px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:${active ? C.tealFill : 'transparent'}; color:${active ? C.tealText : C.body};`)}
                    >
                      {fileLabel(f)}
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
      </aside>

      <section style={css('display:flex; flex-direction:column; min-height:0; min-width:0;')}>
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

              {file.editable && (
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  style={css(`padding:7px 14px; border-radius:8px; cursor:${!dirty || saving ? 'not-allowed' : 'pointer'}; font:inherit; font-size:12px; font-weight:600; border:1px solid ${dirty ? C.tealStroke : C.line}; background:${dirty ? C.tealFill : C.neutralFill}; color:${dirty ? C.tealText : C.faint};`)}
                >{saving ? 'Saving…' : 'Save'}</button>
              )}
            </header>

            {fileError && (
              <p role="alert" style={css(`margin:0; padding:8px 16px; font-size:12px; background:${C.amberFill}; border-bottom:1px solid ${C.amberStroke}; color:var(--cc-amber-text);`)}>{fileError}</p>
            )}

            <div style={css('flex:1; min-height:0; overflow:auto;')}>
              {!file.editable && (file.kind === 'image' || file.kind === 'pdf') ? (
                previewError ? (
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
                  aria-label={`Edit ${file.path}`}
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
