// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeModeProvider } from '../theme-mode'
import { SettingsView } from './SettingsView'

let container: HTMLDivElement
let root: Root

type TestPreferences = {
  theme: 'system' | 'light' | 'dark'
  density: 'comfortable' | 'compact'
  updateCheck: boolean
  anonymousMetrics: boolean | null
  reducedTransparency: boolean
  reducedTransparencyPreference: boolean | null
  systemReducedTransparency: boolean
  highContrast: boolean
}

function preferences(overrides: Partial<TestPreferences> = {}) {
  let current: TestPreferences = {
    theme: 'system', density: 'comfortable', updateCheck: true,
    anonymousMetrics: true, reducedTransparency: false,
    reducedTransparencyPreference: null, systemReducedTransparency: false,
    highContrast: false,
    ...overrides,
  }
  // Mirrors the main process: a patch carries the *choice*, and the effective
  // value is recomputed from it. A mock that just merged the patch would let a
  // renderer bug that confuses the two pass.
  const set = vi.fn().mockImplementation(async (patch: Partial<TestPreferences>) => {
    const next = { ...current, ...patch }
    if ('reducedTransparency' in patch) {
      const choice = (patch.reducedTransparency ?? null) as boolean | null
      next.reducedTransparencyPreference = choice
      next.reducedTransparency = choice ?? current.systemReducedTransparency
    }
    current = next
    return current
  })
  return { initial: current, get: vi.fn().mockImplementation(async () => current), set, onChanged: vi.fn(() => () => {}) }
}

function withDesktopPreferences(overrides: Partial<TestPreferences> = {}) {
  const bridge = preferences(overrides)
  window.__CC_DESKTOP = {
    getApiToken: vi.fn().mockResolvedValue('token'),
    version: '0.0.0-test',
    authState: { signedIn: false, available: false },
    preferences: bridge,
    cli: { getStatus: vi.fn(), install: vi.fn() },
  } as unknown as typeof window.__CC_DESKTOP
  return bridge
}

function button(label: string): HTMLButtonElement {
  const match = findButton(label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
}

/** Scoped by the segmented group's accessible name — "System" is a Theme option too. */
function groupButton(group: string, label: string): HTMLButtonElement {
  const scope = container.querySelector<HTMLElement>(`[role="group"][aria-label="${group}"]`)
  if (!scope) throw new Error(`Segmented group not found: ${group}`)
  const match = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found in ${group}: ${label}`)
  return match
}

/** A build packaged with CC_ACCOUNTS=1. The default build ships without them. */
function withAccountsEnabled(auth: Partial<NonNullable<typeof window.__CC_AUTH>> = {}) {
  window.__CC_DESKTOP = {
    getApiToken: vi.fn().mockResolvedValue('token'),
    version: '0.0.0-test',
    authState: { signedIn: false, available: true },
    preferences: preferences({ theme: 'dark' }),
    metrics: {
      getEnabled: vi.fn().mockResolvedValue(true),
      setEnabled: vi.fn().mockResolvedValue(true),
    },
    cli: { getStatus: vi.fn(), install: vi.fn() },
  } as unknown as typeof window.__CC_DESKTOP
  window.__CC_AUTH = {
    getState: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    signIn: vi.fn().mockResolvedValue(undefined),
    cancelSignIn: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
    onSessionChanged: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    syncSettings: vi.fn().mockResolvedValue({ localOnly: false }),
    pullSettings: vi.fn(),
    getSyncState: vi.fn().mockResolvedValue({ status: 'idle' }),
    onSyncStatus: vi.fn(() => () => {}),
    onSettingsPulled: vi.fn(() => () => {}),
    bootstrapTheme: vi.fn().mockResolvedValue('dark'),
    ...auth,
  } as unknown as typeof window.__CC_AUTH
}

function withDesktopMetrics(enabled = true) {
  const bridge = preferences({ anonymousMetrics: enabled })
  window.__CC_DESKTOP = {
    getApiToken: vi.fn().mockResolvedValue('token'),
    version: '0.0.0-test',
    authState: { signedIn: false, available: false },
    preferences: bridge,
    metrics: { getEnabled: vi.fn().mockResolvedValue(enabled), setEnabled: vi.fn() },
    cli: { getStatus: vi.fn(), install: vi.fn() },
  } as unknown as typeof window.__CC_DESKTOP
  return bridge.set
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  delete window.__CC_AUTH
  delete window.__CC_DESKTOP
  delete window.__CC_INTEGRATIONS
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('data-theme')
  delete window.__CC_AUTH
  delete window.__CC_INTEGRATIONS
})

describe('SettingsView', () => {
  it('renders the desktop Settings window without an in-app Back or Close control', async () => {
    withDesktopMetrics(false)
    await act(async () => root.render(<ThemeModeProvider><SettingsView appMode="live" surface="window" /></ThemeModeProvider>))
    await act(async () => {})
    expect(container.querySelector('.cc-settings-screen')?.getAttribute('data-surface')).toBe('window')
    expect(findButton('Close')).toBeUndefined()
    expect(container.querySelector('.cc-settings-screen')?.hasAttribute('aria-modal')).toBe(false)
  })

  it('offers no Account pane in a build that ships without accounts', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={onClose} />
      </ThemeModeProvider>,
    ))

    // Hidden, not empty. An Account tab that opens onto "sign-in isn't
    // configured" advertises a feature the build does not have.
    expect(findButton('Account')).toBeUndefined()
    expect(container.textContent).not.toContain('ContextCake account')

    await act(async () => button('Close').click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back from a saved pane that is unavailable in this build', async () => {
    const setUiState = vi.fn().mockResolvedValue(undefined)
    const bridge = preferences()
    window.__CC_DESKTOP = {
      getApiToken: vi.fn().mockResolvedValue('token'),
      version: '0.0.0-test',
      authState: { signedIn: false, available: false },
      preferences: bridge,
      uiState: {
        initial: {
          sidebar: { collapsed: false, width: 232 }, lastView: 'overview',
          knowledgeView: 'concepts', reviewView: 'triage', settingsPane: 'account',
        },
        set: setUiState,
      },
      cli: { getStatus: vi.fn(), install: vi.fn() },
    } as unknown as typeof window.__CC_DESKTOP

    await act(async () => root.render(<ThemeModeProvider><SettingsView appMode="live" surface="window" /></ThemeModeProvider>))
    await act(async () => {})

    expect(container.querySelector('h1')?.textContent).toBe('General')
    expect(setUiState).toHaveBeenCalledWith({ settingsPane: 'general' })
  })

  it('keeps account controls inside the settings surface when accounts are enabled', async () => {
    withAccountsEnabled()
    const onClose = vi.fn()
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={onClose} />
      </ThemeModeProvider>,
    ))

    await act(async () => button('Account').click())
    expect(container.textContent).toContain('ContextCake remains fully usable without an account')

    await act(async () => button('Close').click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers GitHub connections independently of ContextCake accounts', async () => {
    const list = vi.fn().mockResolvedValue([{
      alias: 'github.com/octocat', login: 'octocat', gitHost: 'github.com',
      apiHost: 'api.github.com', tokenType: 'pat', createdAt: '2026-08-04T00:00:00.000Z',
    }])
    window.__CC_INTEGRATIONS = {
      list,
      addToken: vi.fn(),
      disconnect: vi.fn().mockResolvedValue({ removed: true }),
    }
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))

    expect(findButton('Account')).toBeUndefined()
    await act(async () => button('Connections').click())
    await act(async () => {})
    expect(list).toHaveBeenCalled()
    expect(container.textContent).toContain('octocat')
    expect(container.textContent).toContain('keychain:github.com/octocat')
  })

  it('applies theme changes immediately', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))

    expect(document.documentElement.dataset.themePreference).toBe('system')
    await act(async () => button('Light').click())
    expect(document.documentElement.dataset.theme).toBe('light')
    await act(async () => button('Dark').click())
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('lets a Mac user override Reduce Transparency and hand the choice back', async () => {
    // This Mac says "reduce": that is what makes System distinguishable from
    // Off. With a Mac that says no, every wrong fallback still renders `false`
    // and the test proves nothing.
    const bridge = withDesktopPreferences({ systemReducedTransparency: true, reducedTransparency: true })
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    // Following this Mac, which asks for reduced transparency.
    expect(container.textContent).toContain('which is currently on')
    expect(groupButton('Reduce transparency', 'System').getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.reducedTransparency).toBe('true')

    // Off is the override that disagrees with the Mac — the whole reason the
    // control exists, and it must take effect without waiting for a round trip.
    await act(async () => groupButton('Reduce transparency', 'Off').click())
    expect(bridge.set).toHaveBeenCalledWith({ reducedTransparency: false })
    expect(document.documentElement.dataset.reducedTransparency).toBe('false')

    await act(async () => groupButton('Reduce transparency', 'On').click())
    expect(bridge.set).toHaveBeenCalledWith({ reducedTransparency: true })
    expect(document.documentElement.dataset.reducedTransparency).toBe('true')

    // Back to System resolves against the Mac's value, not the last override:
    // it lands on true because the Mac says so, not because On was just picked.
    await act(async () => groupButton('Reduce transparency', 'Off').click())
    await act(async () => groupButton('Reduce transparency', 'System').click())
    expect(bridge.set).toHaveBeenCalledWith({ reducedTransparency: null })
    expect(document.documentElement.dataset.reducedTransparency).toBe('true')
  })

  it('starts from an override the app already stored, not from this Mac\'s setting', async () => {
    withDesktopPreferences({
      reducedTransparencyPreference: true, reducedTransparency: true, systemReducedTransparency: false,
    })
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    expect(groupButton('Reduce transparency', 'On').getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.reducedTransparency).toBe('true')
  })

  it('offers no transparency control outside the Mac app', async () => {
    // The browser and demo surfaces have nowhere to persist it; a control that
    // forgets on reload is worse than no control.
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="demo" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})
    expect(container.textContent).not.toContain('Reduce transparency')
  })

  it('holds a setting the Mac could not save, and says it will not survive a restart', async () => {
    // The main process rejects `preferences.set` when the disk write fails, but
    // it has already applied the change and keeps serving it. Snapping the
    // control back would show a state the app is not in — the user would read
    // "on" while updates are genuinely off. Hold the value; report durability.
    const bridge = withDesktopPreferences()
    bridge.set.mockRejectedValue(new Error('settings could not be saved'))
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    const updates = container.querySelector<HTMLInputElement>('input[aria-label="Check for updates automatically"]')
    expect(updates?.checked).toBe(true)
    expect(container.textContent).not.toContain('could not be saved to this Mac')

    await act(async () => updates?.click())
    expect(updates?.checked).toBe(false)
    expect(container.textContent).toContain('could not be saved to this Mac')

    // An appearance change routes through the same file and must report the
    // same way rather than failing silently, which is what it used to do.
    bridge.set.mockClear()
    await act(async () => groupButton('Density', 'Compact').click())
    expect(bridge.set).toHaveBeenCalledWith({ density: 'compact' })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(container.textContent).toContain('could not be saved to this Mac')
  })

  it('clears the unsaved notice once a write lands', async () => {
    const bridge = withDesktopPreferences()
    bridge.set.mockRejectedValueOnce(new Error('settings could not be saved'))
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    await act(async () => groupButton('Density', 'Compact').click())
    expect(container.textContent).toContain('could not be saved to this Mac')

    await act(async () => groupButton('Density', 'Comfortable').click())
    await act(async () => {})
    expect(container.textContent).not.toContain('could not be saved to this Mac')
  })

  it('explains anonymous metrics and lets desktop users opt out', async () => {
    const setEnabled = withDesktopMetrics(true)
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    await act(async () => button('Privacy').click())
    expect(container.textContent).toContain('Anonymous metrics')
    expect(container.textContent).toContain('one-time successful-open signal')
    expect(container.textContent).toContain('It excludes files, paths, prompts, document content')
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Share anonymous usage metrics"]')
    expect(toggle?.checked).toBe(true)

    await act(async () => toggle?.click())
    expect(setEnabled).toHaveBeenCalledWith({ anonymousMetrics: false })
    expect(toggle?.checked).toBe(false)
  })

  it('cancels a pending OAuth attempt when leaving the Account pane', async () => {
    const cancelSignIn = vi.fn().mockResolvedValue({ available: true, signedIn: false })
    withAccountsEnabled({ cancelSignIn })

    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => button('Account').click())
    await act(async () => button('Continue with GitHub').click())
    expect(window.__CC_AUTH?.signIn).toHaveBeenCalledOnce()

    await act(async () => button('General').click())
    expect(cancelSignIn).toHaveBeenCalledOnce()
  })
})
