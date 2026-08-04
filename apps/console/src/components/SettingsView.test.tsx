// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeModeProvider } from '../theme-mode'
import { SettingsView } from './SettingsView'

let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const match = findButton(label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
}

/** A build packaged with CC_ACCOUNTS=1. The default build ships without them. */
function withAccountsEnabled(auth: Partial<NonNullable<typeof window.__CC_AUTH>> = {}) {
  window.__CC_DESKTOP = {
    getApiToken: vi.fn().mockResolvedValue('token'),
    version: '0.0.0-test',
    authState: { signedIn: false, available: true },
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
  const setEnabled = vi.fn().mockImplementation(async (next: boolean) => next)
  window.__CC_DESKTOP = {
    getApiToken: vi.fn().mockResolvedValue('token'),
    version: '0.0.0-test',
    authState: { signedIn: false, available: false },
    metrics: {
      getEnabled: vi.fn().mockResolvedValue(enabled),
      setEnabled,
    },
    cli: { getStatus: vi.fn(), install: vi.fn() },
  } as unknown as typeof window.__CC_DESKTOP
  return setEnabled
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  delete window.__CC_AUTH
  delete window.__CC_DESKTOP
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('data-theme')
  delete window.__CC_AUTH
})

describe('SettingsView', () => {
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

    await act(async () => button('Back to app').click())
    expect(onClose).toHaveBeenCalledOnce()
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
    expect(container.textContent).toContain('ContextCake account')

    await act(async () => button('Back to app').click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('applies theme changes immediately', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))

    expect(document.documentElement.dataset.theme).toBe('dark')
    await act(async () => button('Light').click())
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('explains anonymous metrics and lets desktop users opt out', async () => {
    const setEnabled = withDesktopMetrics(true)
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => {})

    expect(container.textContent).toContain('Anonymous usage metrics')
    expect(container.textContent).toContain('We use this to improve the app')
    expect(container.textContent).toContain('We never collect your files')
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Share anonymous usage metrics"]')
    expect(toggle?.checked).toBe(true)

    await act(async () => toggle?.click())
    expect(setEnabled).toHaveBeenCalledWith(false)
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
    await act(async () => button('Sign in with GitHub').click())
    expect(window.__CC_AUTH?.signIn).toHaveBeenCalledOnce()

    await act(async () => button('General').click())
    expect(cancelSignIn).toHaveBeenCalledOnce()
  })
})
