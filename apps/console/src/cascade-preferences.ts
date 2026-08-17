export type CascadeDisplayMode = 'grouped' | 'compact' | 'cards'

const CASCADE_DISPLAY_KEY = 'contextcake.cascadeDisplay'
const CASCADE_DISPLAY_EVENT = 'contextcake:cascade-display-change'
export const CASCADE_HIDDEN_NODES_KEY = 'contextcake.cascadeHiddenNodes'
const CASCADE_HIDDEN_NODES_EVENT = 'contextcake:cascade-hidden-nodes-change'
const DISPLAY_MODES = new Set<CascadeDisplayMode>(['grouped', 'compact', 'cards'])

function readBrowserCascadeDisplayMode(): CascadeDisplayMode {
  try {
    const saved = localStorage.getItem(CASCADE_DISPLAY_KEY) as CascadeDisplayMode | null
    return saved && DISPLAY_MODES.has(saved) ? saved : 'grouped'
  } catch {
    return 'grouped'
  }
}

export function readCascadeDisplayMode(): CascadeDisplayMode {
  const desktop = window.__CC_DESKTOP?.uiState?.initial.cascadeDisplay
  return desktop && DISPLAY_MODES.has(desktop) ? desktop : readBrowserCascadeDisplayMode()
}

export async function writeCascadeDisplayMode(mode: CascadeDisplayMode): Promise<void> {
  if (!DISPLAY_MODES.has(mode)) return
  try { localStorage.setItem(CASCADE_DISPLAY_KEY, mode) } catch { /* optional preference */ }
  window.dispatchEvent(new CustomEvent<CascadeDisplayMode>(CASCADE_DISPLAY_EVENT, { detail: mode }))
  await window.__CC_DESKTOP?.uiState?.set({ cascadeDisplay: mode })
}

export function onCascadeDisplayModeChange(listener: (mode: CascadeDisplayMode) => void): () => void {
  const onLocalChange = (event: Event) => {
    const mode = (event as CustomEvent<CascadeDisplayMode>).detail
    if (DISPLAY_MODES.has(mode)) listener(mode)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === CASCADE_DISPLAY_KEY) listener(readBrowserCascadeDisplayMode())
  }
  window.addEventListener(CASCADE_DISPLAY_EVENT, onLocalChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CASCADE_DISPLAY_EVENT, onLocalChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function onCascadeHiddenNodesChange(listener: () => void): () => void {
  const onLocalChange = () => listener()
  const onStorage = (event: StorageEvent) => {
    if (event.key === CASCADE_HIDDEN_NODES_KEY) listener()
  }
  window.addEventListener(CASCADE_HIDDEN_NODES_EVENT, onLocalChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CASCADE_HIDDEN_NODES_EVENT, onLocalChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Clear the browser copy after a desktop settings reset. The native reset
 * already removed the durable uiState fields; storage/custom events keep the
 * current renderer windows in sync with that new default. */
export function resetCascadeLocalPreferences(): void {
  try {
    localStorage.removeItem(CASCADE_DISPLAY_KEY)
    localStorage.removeItem(CASCADE_HIDDEN_NODES_KEY)
  } catch { /* optional preferences */ }
  window.dispatchEvent(new CustomEvent<CascadeDisplayMode>(CASCADE_DISPLAY_EVENT, { detail: 'grouped' }))
  window.dispatchEvent(new Event(CASCADE_HIDDEN_NODES_EVENT))
}
