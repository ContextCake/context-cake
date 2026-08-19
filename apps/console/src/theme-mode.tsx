import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_PALETTE, PALETTE_IDS, isPaletteId, type PaletteId } from './themes/registry'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'
export type { PaletteId } from './themes/registry'

// Two appearance axes, and their names differ between code and UI on purpose
// (the code names predate the second axis and are what the desktop settings
// file and Supabase sync already carry):
//   code `theme`   — UI "Appearance": system / light / dark
//   code `palette` — UI "Theme": which family (ContextCake, Solarized, …)
const THEME_KEY = 'cc-theme'
const DENSITY_KEY = 'cc-density'
const PALETTE_KEY = 'cc-palette'
const THEME_VALUES = new Set<ThemePreference>(['system', 'light', 'dark'])
const DENSITY_VALUES = new Set<Density>(['comfortable', 'compact'])
const PALETTE_VALUES = new Set<PaletteId>(PALETTE_IDS)

/**
 * Reduce transparency is three values, not one. `reducedTransparency` is what
 * the renderer does; `reducedTransparencyPreference` is what the user chose,
 * with null meaning "still following this Mac"; `systemReducedTransparency` is
 * what the Mac says, kept so Settings can show what "System" resolves to
 * without asking the main process again.
 */
type Appearance = {
  preference: ThemePreference
  palette: PaletteId
  density: Density
  reducedTransparency: boolean
  reducedTransparencyPreference: boolean | null
  systemReducedTransparency: boolean
  highContrast: boolean
}

/** The user's three choices for reduce transparency, as a control can spell them. */
export type TransparencyChoice = 'system' | 'on' | 'off'

export function transparencyChoice(preference: boolean | null): TransparencyChoice {
  return preference === null ? 'system' : preference ? 'on' : 'off'
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

/**
 * The desktop hands over whatever slug settings.json holds — its validation is
 * shape-only (a newer app or a hand edit may name a family this build lacks),
 * so an unknown id renders as ContextCake here. It is NOT written back: the
 * file keeps the user's choice until they pick something on this build.
 */
export function initialPalette(): PaletteId {
  const desktop = window.__CC_DESKTOP?.preferences?.initial
  if (desktop) return normalizePalette(desktop.palette)
  return storedValue(PALETTE_KEY, PALETTE_VALUES, DEFAULT_PALETTE)
}

export function normalizePalette(value: unknown): PaletteId {
  return isPaletteId(value) ? value : DEFAULT_PALETTE
}

function initialAppearance(): Appearance {
  const desktop = window.__CC_DESKTOP?.preferences?.initial
  return {
    preference: desktop?.theme ?? initialPreference(),
    palette: initialPalette(),
    density: desktop?.density ?? initialDensity(),
    reducedTransparency: desktop?.reducedTransparency ?? false,
    reducedTransparencyPreference: desktop?.reducedTransparencyPreference ?? null,
    systemReducedTransparency: desktop?.systemReducedTransparency ?? false,
    highContrast: desktop?.highContrast ?? false,
  }
}

/** The preference snapshot the desktop bridge hands back. `desktop.d.ts` keeps
 *  its own name for it module-scoped, so read the shape off the bridge itself
 *  rather than restating it here and letting the two drift. */
type DesktopPreferenceSnapshot = NonNullable<NonNullable<Window['__CC_DESKTOP']>['preferences']>['initial']

/** Every appearance field the main process reports, in one place: three call sites read it. */
function appearanceFrom(next: DesktopPreferenceSnapshot): Appearance {
  return {
    preference: next.theme,
    palette: normalizePalette(next.palette),
    density: next.density,
    reducedTransparency: next.reducedTransparency,
    reducedTransparencyPreference: next.reducedTransparencyPreference ?? null,
    systemReducedTransparency: next.systemReducedTransparency ?? false,
    highContrast: next.highContrast,
  }
}

export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(appearance.preference)
  root.dataset.themePreference = appearance.preference
  root.dataset.palette = appearance.palette
  root.dataset.density = appearance.density
  root.dataset.reducedTransparency = String(appearance.reducedTransparency)
  root.dataset.highContrast = String(appearance.highContrast)
}

/** Apply synchronously before React mounts to prevent an appearance flash. */
export function applyInitialAppearance() {
  document.documentElement.dataset.nativeVibrancy = String(window.__CC_DESKTOP?.nativeVibrancy === true)
  applyAppearance(initialAppearance())
}

// Compatibility exports for existing consumers while the shell migrates.
export function initialMode(): ResolvedTheme {
  return resolveTheme(initialPreference())
}

export function applyMode(mode: ResolvedTheme) {
  applyAppearance({
    preference: mode,
    palette: initialPalette(),
    density: initialDensity(),
    reducedTransparency: false,
    reducedTransparencyPreference: null,
    systemReducedTransparency: false,
    highContrast: false,
  })
}

interface ThemeCtx {
  mode: ResolvedTheme
  preference: ThemePreference
  /** The theme family in effect (UI "Theme"); always a shipped id. */
  palette: PaletteId
  density: Density
  /** What the renderer is doing right now. */
  reducedTransparency: boolean
  /** What the user chose; null while still following this Mac's setting. */
  transparency: TransparencyChoice
  /** What "System" currently resolves to, for the hint under the control. */
  systemReducedTransparency: boolean
  setPreference: (preference: ThemePreference) => void
  setPalette: (palette: PaletteId) => void
  setDensity: (density: Density) => void
  setTransparency: (choice: TransparencyChoice) => void
  toggle: () => void
  /**
   * The Mac app could not write the last appearance change to disk. The change
   * is in effect — the main process applied it and every read returns it — but
   * it will not survive a restart, which is the part a user cannot see and has
   * to be told. Cleared by the next write that lands.
   */
  saveFailed: boolean
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance)

  useEffect(() => {
    applyAppearance(appearance)
    if (!window.__CC_DESKTOP) {
      // The palette key is deliberately absent here: `appearance.palette` is
      // the NORMALIZED id, and an unknown stored id (a family this build lacks)
      // must not be overwritten by the fallback — `setPalette` writes it on a
      // user's pick, matching the desktop rule.
      try {
        localStorage.setItem(THEME_KEY, appearance.preference)
        localStorage.setItem(DENSITY_KEY, appearance.density)
      } catch { /* persistence is best-effort in browser/private mode */ }
    }
  }, [appearance])

  useEffect(() => {
    const preferences = window.__CC_DESKTOP?.preferences
    if (preferences) {
      preferences.get().then((next) => setAppearance(appearanceFrom(next))).catch(() => {})
      return preferences.onChanged((next) => setAppearance(appearanceFrom(next)))
    }

    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const updateSystemTheme = () => setAppearance((current) => ({ ...current }))
    const updateFromStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== DENSITY_KEY && event.key !== PALETTE_KEY) return
      setAppearance((current) => ({
        ...current,
        preference: initialPreference(),
        palette: initialPalette(),
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

  const [saveFailed, setSaveFailed] = useState(false)

  /**
   * Persist an appearance change, and remember whether it reached the disk.
   *
   * `preferences.set` began rejecting when the write fails; swallowing that is
   * what this codebase keeps getting wrong. Note what is deliberately NOT done
   * here: the change is not rolled back. The main process applied it and every
   * `readSettings()` returns it, so reverting the control would show a state
   * the app is not in. What the user loses is durability, so that — and only
   * that — is what gets reported.
   */
  const persist = useCallback((patch: Parameters<NonNullable<NonNullable<Window['__CC_DESKTOP']>['preferences']>['set']>[0]) => {
    const bridge = window.__CC_DESKTOP?.preferences
    if (!bridge) return
    bridge.set(patch).then(() => setSaveFailed(false), () => setSaveFailed(true))
  }, [])

  const setPreference = useCallback((preference: ThemePreference) => {
    if (!THEME_VALUES.has(preference)) return
    setAppearance((current) => current.preference === preference ? current : { ...current, preference })
    persist({ theme: preference })
  }, [persist])

  const setPalette = useCallback((palette: PaletteId) => {
    if (!PALETTE_VALUES.has(palette)) return
    setAppearance((current) => current.palette === palette ? current : { ...current, palette })
    if (window.__CC_DESKTOP) persist({ palette })
    else try { localStorage.setItem(PALETTE_KEY, palette) } catch { /* best-effort, as above */ }
  }, [persist])

  const setDensity = useCallback((density: Density) => {
    if (!DENSITY_VALUES.has(density)) return
    setAppearance((current) => current.density === density ? current : { ...current, density })
    persist({ density })
  }, [persist])

  const setTransparency = useCallback((choice: TransparencyChoice) => {
    const preference = choice === 'system' ? null : choice === 'on'
    // Apply immediately against the system value we already hold, so the window
    // changes on the click rather than on the IPC round trip; the main process's
    // `preferences:changed` broadcast is what makes it authoritative.
    setAppearance((current) => current.reducedTransparencyPreference === preference ? current : {
      ...current,
      reducedTransparencyPreference: preference,
      reducedTransparency: preference ?? current.systemReducedTransparency,
    })
    persist({ reducedTransparency: preference })
  }, [persist])

  const mode = resolveTheme(appearance.preference)
  const toggle = useCallback(() => setPreference(mode === 'dark' ? 'light' : 'dark'), [mode, setPreference])
  const value = useMemo(() => ({
    mode,
    preference: appearance.preference,
    palette: appearance.palette,
    density: appearance.density,
    reducedTransparency: appearance.reducedTransparency,
    transparency: transparencyChoice(appearance.reducedTransparencyPreference),
    systemReducedTransparency: appearance.systemReducedTransparency,
    setPreference,
    setPalette,
    setDensity,
    setTransparency,
    toggle,
    saveFailed,
  }), [
    appearance.density, appearance.palette, appearance.preference, appearance.reducedTransparency,
    appearance.reducedTransparencyPreference, appearance.systemReducedTransparency,
    mode, saveFailed, setDensity, setPalette, setPreference, setTransparency, toggle,
  ])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useThemeMode(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider')
  return ctx
}
