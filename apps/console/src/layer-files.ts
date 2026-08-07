// The `/api/files` listing, shared by the two views that need it.
//
// Sources reads it for a source's file count and root path; Files reads it to
// build the navigator tree; the concept detail reads it to find the file
// behind each contributor. One module so they all ask the same question the
// same way — and so a source that owns no local files (a remote graph, a
// REST-read repo) is absent from the payload in exactly one place, which is
// what lets every consumer explain that state instead of rendering an empty
// list or an "open file" link that opens nothing.
//
// Deliberately uncached. The walk is bounded and cheap — 20–40ms and 440KB on
// a 3,030-file vault — so a per-mount fetch costs less than the staleness a
// shared cache would introduce (a note added in Finder has to show up the next
// time you look).
import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import type { LayerFiles } from './types'

export async function fetchLayerFiles(): Promise<LayerFiles[]> {
  const res = await apiFetch('/api/files', { headers: { accept: 'application/json' } })
  const data = await res.json().catch(() => ({}) as { error?: string; layers?: LayerFiles[] })
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return (data as { layers?: LayerFiles[] }).layers ?? []
}

export interface LayerFilesState {
  /** Null until the first answer lands — "unknown", never "empty". */
  layers: LayerFiles[] | null
  error: string | null
}

/**
 * `revalidate` re-runs the walk when it changes; pass whatever identifies the
 * current source set. The listing is cheap even mid-index, so this deliberately
 * does not wait on the cascade.
 */
export function useLayerFiles(enabled: boolean, revalidate: unknown): LayerFilesState {
  const [state, setState] = useState<LayerFilesState>({ layers: null, error: null })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const layers = await fetchLayerFiles()
        if (!cancelled) setState({ layers, error: null })
      } catch (e) {
        if (!cancelled) setState({ layers: null, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [enabled, revalidate])

  return state
}
