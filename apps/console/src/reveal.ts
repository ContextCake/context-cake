// "Reveal in Finder", the console half.
//
// Desktop only, and ABSENT rather than disabled on the web: a control that can
// never do anything says less than no control at all. `available` is what the
// views gate on, so nothing about Finder ships into the browser build's UI.
//
// The bridge takes a source name and a path inside it — never an absolute
// path. The main process resolves it against the manifest and refuses anything
// that escapes the source's folder (apps/desktop/src/main/reveal.mjs), so the
// error this hook surfaces can be a refusal as well as a missing file.
import { useCallback, useState } from 'react'

export interface RevealState {
  /** True only inside the desktop app. Hide the control entirely when false. */
  available: boolean
  /** The last refusal, verbatim from the main process. */
  error: string | null
  reveal: (layer: string, rel: string) => Promise<void>
  clearError: () => void
}

export function useReveal(): RevealState {
  const [error, setError] = useState<string | null>(null)
  const available = typeof window.__CC_DESKTOP?.revealFile === 'function'

  const reveal = useCallback(async (layer: string, rel: string) => {
    const bridge = window.__CC_DESKTOP?.revealFile
    if (!bridge) return
    setError(null)
    try {
      const result = await bridge(layer, rel)
      if (!result?.ok) setError(result?.error ?? 'That file could not be revealed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])
  return { available, error, reveal, clearError }
}
