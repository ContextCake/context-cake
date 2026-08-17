export type CascadeDisplayMode = 'grouped' | 'compact' | 'cards'

const CASCADE_DISPLAY_KEY = 'contextcake.cascadeDisplay'
const CASCADE_DISPLAY_EVENT = 'contextcake:cascade-display-change'
const DISPLAY_MODES = new Set<CascadeDisplayMode>(['grouped', 'compact', 'cards'])

export function readCascadeDisplayMode(): CascadeDisplayMode {
  try {
    const saved = localStorage.getItem(CASCADE_DISPLAY_KEY) as CascadeDisplayMode | null
    return saved && DISPLAY_MODES.has(saved) ? saved : 'grouped'
  } catch {
    return 'grouped'
  }
}

export function writeCascadeDisplayMode(mode: CascadeDisplayMode): void {
  if (!DISPLAY_MODES.has(mode)) return
  try { localStorage.setItem(CASCADE_DISPLAY_KEY, mode) } catch { /* optional preference */ }
  window.dispatchEvent(new CustomEvent<CascadeDisplayMode>(CASCADE_DISPLAY_EVENT, { detail: mode }))
}

export function onCascadeDisplayModeChange(listener: (mode: CascadeDisplayMode) => void): () => void {
  const onLocalChange = (event: Event) => {
    const mode = (event as CustomEvent<CascadeDisplayMode>).detail
    if (DISPLAY_MODES.has(mode)) listener(mode)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === CASCADE_DISPLAY_KEY) listener(readCascadeDisplayMode())
  }
  window.addEventListener(CASCADE_DISPLAY_EVENT, onLocalChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CASCADE_DISPLAY_EVENT, onLocalChange)
    window.removeEventListener('storage', onStorage)
  }
}
