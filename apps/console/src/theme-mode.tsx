import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

type Mode = 'dark' | 'light'
const KEY = 'cc-theme'

/** Read the persisted choice, defaulting to the dark control plane. */
export function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* ignore */ }
  return 'dark'
}

/** Apply before React mounts so there's no theme flash. */
export function applyMode(mode: Mode) {
  document.documentElement.dataset.theme = mode
}

interface ThemeCtx { mode: Mode; toggle: () => void }
const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(initialMode)

  useEffect(() => {
    applyMode(mode)
    try { localStorage.setItem(KEY, mode) } catch { /* ignore */ }
  }, [mode])

  const toggle = useCallback(() => setMode((m) => (m === 'dark' ? 'light' : 'dark')), [])

  return <Ctx.Provider value={{ mode, toggle }}>{children}</Ctx.Provider>
}

export function useThemeMode(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider')
  return ctx
}
