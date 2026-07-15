// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeModeProvider } from '../theme-mode'
import { SettingsView } from './SettingsView'

let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
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
  it('keeps account controls inside the settings surface', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={onClose} />
      </ThemeModeProvider>,
    ))

    await act(async () => button('Account').click())
    expect(container.textContent).toContain('Account sign-in is available in the ContextCake desktop app.')

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

  it('cancels a pending OAuth attempt when leaving the Account pane', async () => {
    const cancelSignIn = vi.fn().mockResolvedValue({ available: true, signedIn: false })
    window.__CC_AUTH = {
      getState: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
      signIn: vi.fn().mockResolvedValue(undefined),
      cancelSignIn,
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
    }

    await act(async () => root.render(
      <ThemeModeProvider>
        <SettingsView appMode="live" onClose={vi.fn()} />
      </ThemeModeProvider>,
    ))
    await act(async () => button('Account').click())
    await act(async () => button('Sign in with GitHub').click())
    expect(window.__CC_AUTH.signIn).toHaveBeenCalledOnce()

    await act(async () => button('General').click())
    expect(cancelSignIn).toHaveBeenCalledOnce()
  })
})
