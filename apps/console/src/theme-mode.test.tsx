// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeModeProvider, applyInitialAppearance, initialDensity, initialPreference, useThemeMode } from './theme-mode'

let dark = false
let notify: (() => void) | undefined

function Controls() {
  const appearance = useThemeMode()
  return <>
    <output>{appearance.preference}:{appearance.mode}:{appearance.density}</output>
    <button onClick={() => appearance.setPreference('system')}>System</button>
    <button onClick={() => appearance.setDensity('compact')}>Compact</button>
  </>
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
  for (const key of ['theme', 'themePreference', 'density', 'reducedTransparency', 'highContrast', 'nativeVibrancy']) {
    delete document.documentElement.dataset[key]
  }
})

describe('appearance preferences', () => {
  it('preserves valid explicit browser choices and migrates missing values to product defaults', () => {
    expect(initialPreference()).toBe('system')
    expect(initialDensity()).toBe('comfortable')
    localStorage.setItem('cc-theme', 'dark')
    localStorage.setItem('cc-density', 'compact')
    expect(initialPreference()).toBe('dark')
    expect(initialDensity()).toBe('compact')
    applyInitialAppearance()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.nativeVibrancy).toBe('false')
  })

  it('marks native material availability before the first paint', () => {
    window.__CC_DESKTOP = { nativeVibrancy: true } as NonNullable<Window['__CC_DESKTOP']>
    applyInitialAppearance()
    expect(document.documentElement.dataset.nativeVibrancy).toBe('true')
  })

  it('resolves System immediately when the operating-system appearance changes', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<ThemeModeProvider><Controls /></ThemeModeProvider>))
    expect(host.textContent).toContain('system:light:comfortable')
    dark = true
    await act(async () => notify?.())
    expect(host.textContent).toContain('system:dark:comfortable')
    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Compact')?.click())
    expect(document.documentElement.dataset.density).toBe('compact')
    await act(async () => root.unmount())
  })
})
