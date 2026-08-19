// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeModeProvider, applyInitialAppearance, initialDensity, initialPalette, initialPreference, useThemeMode } from './theme-mode'

let dark = false
let notify: (() => void) | undefined

function Controls() {
  const appearance = useThemeMode()
  return <>
    <output>{appearance.preference}:{appearance.mode}:{appearance.density}:{appearance.palette}</output>
    <button onClick={() => appearance.setPreference('system')}>System</button>
    <button onClick={() => appearance.setDensity('compact')}>Compact</button>
    <button onClick={() => appearance.setPalette('gruvbox')}>Gruvbox</button>
  </>
}

/** A desktop bridge that reports `initial` and records what the renderer asks it to persist. */
function desktopBridge(initial: { theme?: 'system' | 'light' | 'dark'; palette?: string; density?: 'comfortable' | 'compact' } = {}) {
  const snapshot = {
    theme: 'system' as const, palette: 'contextcake', density: 'comfortable' as const,
    updateCheck: true, anonymousMetrics: null, reducedTransparency: false,
    reducedTransparencyPreference: null, systemReducedTransparency: false, highContrast: false,
    ...initial,
  }
  const set = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({ ...snapshot, ...patch }))
  window.__CC_DESKTOP = {
    nativeVibrancy: true,
    preferences: { initial: snapshot, get: vi.fn().mockResolvedValue(snapshot), set, onChanged: vi.fn(() => () => {}) },
  } as unknown as NonNullable<Window['__CC_DESKTOP']>
  return set
}

beforeEach(() => {
  window.localStorage.clear()
  delete window.__CC_DESKTOP
  dark = false
  notify = undefined
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => { notify = listener },
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ['theme', 'themePreference', 'palette', 'density', 'reducedTransparency', 'highContrast', 'nativeVibrancy']) {
    delete document.documentElement.dataset[key]
  }
})

describe('appearance preferences', () => {
  it('preserves valid explicit browser choices and migrates missing values to product defaults', () => {
    expect(initialPreference()).toBe('system')
    expect(initialDensity()).toBe('comfortable')
    expect(initialPalette()).toBe('contextcake')
    localStorage.setItem('cc-theme', 'dark')
    localStorage.setItem('cc-density', 'compact')
    localStorage.setItem('cc-palette', 'solarized')
    expect(initialPreference()).toBe('dark')
    expect(initialDensity()).toBe('compact')
    expect(initialPalette()).toBe('solarized')
    applyInitialAppearance()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.palette).toBe('solarized')
    expect(document.documentElement.dataset.nativeVibrancy).toBe('false')
  })

  it('renders an unknown stored palette as ContextCake rather than an unstyled page', async () => {
    // A family removed in an update, or a hand-edited key: nothing in
    // src/themes/ answers to it, and <html data-palette="…"> would then take
    // no family block — the derived block still applies, so half the tokens
    // would come from a family that does not exist. Fall back to the default.
    localStorage.setItem('cc-palette', 'nord')
    expect(initialPalette()).toBe('contextcake')
    applyInitialAppearance()
    expect(document.documentElement.dataset.palette).toBe('contextcake')
    // …and the stored id survives the fallback: mounting must not write the
    // normalized value back over a choice a newer build might understand.
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<ThemeModeProvider><Controls /></ThemeModeProvider>))
    expect(localStorage.getItem('cc-palette')).toBe('nord')
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Gruvbox')?.click())
    expect(localStorage.getItem('cc-palette')).toBe('gruvbox')
    await act(async () => root.unmount())
  })

  it('marks native material availability and applies the desktop palette before the first paint', () => {
    desktopBridge({ palette: 'catppuccin', theme: 'light' })
    applyInitialAppearance()
    expect(document.documentElement.dataset.nativeVibrancy).toBe('true')
    expect(document.documentElement.dataset.palette).toBe('catppuccin')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('normalizes an unknown desktop palette without writing it back to the Mac', async () => {
    // settings.json validation is shape-only (a newer app may know more
    // families than this build), so the id can be anything slug-shaped. It
    // renders as ContextCake, and the file keeps the user's choice: no
    // `preferences.set` fires until they pick something here.
    const set = desktopBridge({ palette: 'everforest' })
    expect(initialPalette()).toBe('contextcake')
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<ThemeModeProvider><Controls /></ThemeModeProvider>))
    expect(host.textContent).toContain(':contextcake')
    expect(document.documentElement.dataset.palette).toBe('contextcake')
    expect(set).not.toHaveBeenCalled()
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Gruvbox')?.click())
    expect(document.documentElement.dataset.palette).toBe('gruvbox')
    expect(set).toHaveBeenCalledWith({ palette: 'gruvbox' })
    await act(async () => root.unmount())
  })

  it('resolves System immediately when the operating-system appearance changes', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<ThemeModeProvider><Controls /></ThemeModeProvider>))
    expect(host.textContent).toContain('system:light:comfortable:contextcake')
    dark = true
    await act(async () => notify?.())
    expect(host.textContent).toContain('system:dark:comfortable:contextcake')
    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Compact')?.click())
    expect(document.documentElement.dataset.density).toBe('compact')
    await act(async () => root.unmount())
  })

  it('applies a theme family immediately and remembers it in the browser', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<ThemeModeProvider><Controls /></ThemeModeProvider>))
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Gruvbox')?.click())
    expect(host.textContent).toContain(':gruvbox')
    expect(document.documentElement.dataset.palette).toBe('gruvbox')
    expect(localStorage.getItem('cc-palette')).toBe('gruvbox')
    // Appearance is a separate axis: the family survives a mode change.
    dark = true
    await act(async () => notify?.())
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.palette).toBe('gruvbox')
    await act(async () => root.unmount())
  })
})
