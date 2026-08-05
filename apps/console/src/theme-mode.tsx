import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'cc-theme'
const DENSITY_KEY = 'cc-density'
const THEME_VALUES = new Set<ThemePreference>(['system', 'light', 'dark'])
const DENSITY_VALUES = new Set<Density>(['comfortable', 'compact'])

type Appearance = {
  preference: ThemePreference
  density: Density
  reducedTransparency: boolean
  highContrast: boolean
}

function browserSystemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? browserSystemTheme() : preference
}

function storedValue<T extends string>(key: string, allowed: Set<T>, fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.has(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function initialPreference(): ThemePreference {
  return window.__CC_DESKTOP?.preferences?.initial.theme
    ?? storedValue(THEME_KEY, THEME_VALUES, 'system')
}

export function initialDensity(): Density {
  return window.__CC_DESKTOP?.preferences?.initial.density
    ?? storedValue(DENSITY_KEY, DENSITY_VALUES, 'comfortable')
}

function initialAppearance(): Appearance {
  const desktop = window.__CC_DESKTOP?.preferences?.initial
  return {
    preference: desktop?.theme ?? initialPreference(),
    density: desktop?.density ?? initialDensity(),
    reducedTransparency: desktop?.reducedTransparency ?? false,
    highContrast: desktop?.highContrast ?? false,
  }
}

export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(appearance.preference)
  root.dataset.themePreference = appearance.preference
  root.dataset.density = appearance.density
  root.dataset.reducedTransparency = String(appearance.reducedTransparency)
  root.dataset.highContrast = String(appearance.highContrast)
}

/** Apply synchronously before React mounts to prevent an appearance flash. */
export function applyInitialAppearance() {
  applyAppearance(initialAppearance())
}

// Compatibility exports for existing consumers while the shell migrates.
export function initialMode(): ResolvedTheme {
  return resolveTheme(initialPreference())
}

export function applyMode(mode: ResolvedTheme) {
  applyAppearance({ preference: mode, density: initialDensity(), reducedTransparency: false, highContrast: false })
}

interface ThemeCtx {
  mode: ResolvedTheme
  preference: ThemePreference
  density: Density
  setPreference: (preference: ThemePreference) => void
  setDensity: (density: Density) => void
  toggle: () => void
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance)

  useEffect(() => {
    applyAppearance(appearance)
    if (!window.__CC_DESKTOP) {
      try {
        localStorage.setItem(THEME_KEY, appearance.preference)
        localStorage.setItem(DENSITY_KEY, appearance.density)
      } catch { /* persistence is best-effort in browser/private mode */ }
    }
  }, [appearance])

  useEffect(() => {
    const preferences = window.__CC_DESKTOP?.preferences
    if (preferences) {
      preferences.get().then((next) => setAppearance({
        preference: next.theme,
        density: next.density,
        reducedTransparency: next.reducedTransparency,
        highContrast: next.highContrast,
      })).catch(() => {})
      return preferences.onChanged((next) => setAppearance({
        preference: next.theme,
        density: next.density,
        reducedTransparency: next.reducedTransparency,
        highContrast: next.highContrast,
      }))
    }

    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const updateSystemTheme = () => setAppearance((current) => ({ ...current }))
    const updateFromStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== DENSITY_KEY) return
      setAppearance((current) => ({
        ...current,
        preference: initialPreference(),
        density: initialDensity(),
      }))
    }
    media.addEventListener('change', updateSystemTheme)
    addEventListener('storage', updateFromStorage)
    return () => {
      media.removeEventListener('change', updateSystemTheme)
      removeEventListener('storage', updateFromStorage)
    }
  }, [])

  const setPreference = useCallback((preference: ThemePreference) => {
    if (!THEME_VALUES.has(preference)) return
    setAppearance((current) => current.preference === preference ? current : { ...current, preference })
    window.__CC_DESKTOP?.preferences?.set({ theme: preference }).catch(() => {})
  }, [])

  const setDensity = useCallback((density: Density) => {
    if (!DENSITY_VALUES.has(density)) return
    setAppearance((current) => current.density === density ? current : { ...current, density })
    window.__CC_DESKTOP?.preferences?.set({ density }).catch(() => {})
  }, [])

  const mode = resolveTheme(appearance.preference)
  const toggle = useCallback(() => setPreference(mode === 'dark' ? 'light' : 'dark'), [mode, setPreference])
  const value = useMemo(() => ({
    mode,
    preference: appearance.preference,
    density: appearance.density,
    setPreference,
    setDensity,
    toggle,
  }), [appearance.density, appearance.preference, mode, setDensity, setPreference, toggle])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useThemeMode(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider')
  return ctx
}
