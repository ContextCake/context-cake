// The `/api/files` listing and the `/api/file` read, shared by every view that
// needs them.
//
// Sources reads the listing for a source's file count and root path; Files reads
// it to build the navigator tree; the concept detail reads it to find the file
// behind each contributor. One module so they all ask the same question the
// same way — and so a source that owns no local files (a remote graph, a
// REST-read repo) is absent from the payload in exactly one place, which is
// what lets every consumer explain that state instead of rendering an empty
// list or an "open file" link that opens nothing.
//
// This is also the mode seam for files, mirroring `api.ts`:
//
//   demo mode — a build-time snapshot of the engine's own file APIs over the
//               demo bundle (scripts/build-demo-data.mjs). Never hand-authored,
//               and read-only: it holds the two GET answers and nothing else,
//               so nothing in the demo can pretend a write happened.
//   live mode — the same-origin engine routes.
//
// Deliberately uncached in live mode. The walk is bounded and cheap — 20–40ms
// and 440KB on a 3,030-file vault — so a per-mount fetch costs less than the
// staleness a shared cache would introduce (a note added in Finder has to show
// up the next time you look).
import { useEffect, useState } from 'react'
import { apiFetch, type Mode } from './api'
import demoFilesRaw from './generated/demo-files.json'
import type { DemoFiles, FileContent, LayerFiles } from './types'

const demoFiles = demoFilesRaw as unknown as DemoFiles

export async function fetchLayerFiles(mode: Mode): Promise<LayerFiles[]> {
  if (mode === 'demo') return demoFiles.layers
  const res = await apiFetch('/api/files', { headers: { accept: 'application/json' } })
  const data = await res.json().catch(() => ({}) as { error?: string; layers?: LayerFiles[] })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return (data as { layers?: LayerFiles[] }).layers ?? []
}

/** One file's content and metadata — the demo answers from the snapshot. */
export async function readLayerFile(mode: Mode, path: string): Promise<FileContent> {
  if (mode === 'demo') {
    const file = demoFiles.files[path]
    // Same words the engine uses for a path it cannot resolve, so a caller that
    // renders the message reads the same in both modes.
    if (!file) throw new Error(`Not found: ${path}`)
    return file
  }
  const res = await apiFetch(`/api/file?path=${encodeURIComponent(path)}`, { headers: { accept: 'application/json' } })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return data as FileContent
}

export interface LayerFilesState {
  /** Null until the first answer lands — "unknown", never "empty". */
  layers: LayerFiles[] | null
  error: string | null
}

/**
 * `revalidate` re-runs the walk when it changes; pass whatever identifies the
 * current source set. The listing is cheap even mid-index, so this deliberately
 * does not wait on the cascade. The demo snapshot is already in the bundle, so
 * it is the initial state rather than something to wait a frame for — the tree
 * must not flash its loading skeleton over data the page shipped with.
 */
export function useLayerFiles(mode: Mode, revalidate: unknown): LayerFilesState {
  const [state, setState] = useState<LayerFilesState>(
    () => ({ layers: mode === 'demo' ? demoFiles.layers : null, error: null }),
  )

  useEffect(() => {
    if (mode === 'demo') {
      // Same array identity as the initial state, so React bails out instead of
      // re-rendering the tree every time `revalidate` moves.
      setState((current) => (current.layers === demoFiles.layers ? current : { layers: demoFiles.layers, error: null }))
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const layers = await fetchLayerFiles(mode)
        if (!cancelled) setState({ layers, error: null })
      } catch (e) {
        if (!cancelled) setState({ layers: null, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [mode, revalidate])

  return state
}
