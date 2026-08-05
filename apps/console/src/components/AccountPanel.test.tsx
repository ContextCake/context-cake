// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPanel } from './AccountPanel'

let container: HTMLDivElement
let root: Root

function bridge(overrides: Partial<NonNullable<typeof window.__CC_AUTH>> = {}) {
  const value = {
    getState: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    signIn: vi.fn().mockResolvedValue({ opened: true }),
    cancelSignIn: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    signOut: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    deleteAccount: vi.fn().mockResolvedValue({ available: true, signedIn: false }),
    onSessionChanged: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    pullSettings: vi.fn().mockResolvedValue({ overwritten: false, settings: {} }),
    getSyncState: vi.fn().mockResolvedValue({ status: 'idle' }),
    onSyncStatus: vi.fn(() => () => {}),
    ...overrides,
  } as NonNullable<typeof window.__CC_AUTH>
  window.__CC_AUTH = value
  window.__CC_DESKTOP = {
    getApiToken: vi.fn(), version: 'test', authState: { available: true, signedIn: false },
    cli: { getStatus: vi.fn(), install: vi.fn() },
  } as unknown as typeof window.__CC_DESKTOP
  return value
}

function button(label: string) {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.__CC_AUTH
  delete window.__CC_DESKTOP
})

describe('AccountPanel', () => {
  it('presents optional local-first sign-in and a cancellable browser-pending state', async () => {
    const auth = bridge()
    await act(async () => root.render(<AccountPanel />))
    await act(async () => {})
    expect(container.textContent).toContain('ContextCake remains fully usable without an account')
    expect(container.textContent).toContain('never uploads document contents, local paths, commands, or credentials')

    await act(async () => button('Continue with GitHub').click())
    expect(auth.signIn).toHaveBeenCalledWith('github')
    expect(container.textContent).toContain('Finish signing in in your browser')
    await act(async () => button('Cancel').click())
    expect(auth.cancelSignIn).toHaveBeenCalledOnce()
  })

  it('shows signed-in identity, sync result and exact timestamps', async () => {
    const updatedAt = '2026-08-05T04:00:00.000Z'
    const auth = bridge({
      getState: vi.fn().mockResolvedValue({ available: true, signedIn: true, email: 'person@example.com' }),
      getSyncState: vi.fn().mockResolvedValue({ status: 'synced', updatedAt, overwritten: false }),
    })
    window.__CC_DESKTOP!.authState = { available: true, signedIn: true, email: 'person@example.com' }
    await act(async () => root.render(<AccountPanel />))
    await act(async () => {})
    expect(container.textContent).toContain('person@example.com')
    expect(container.textContent).toContain('Connected with GitHub')
    expect(container.querySelector('[title]')?.getAttribute('title')).toContain('2026')
    await act(async () => button('Sync now').click())
    expect(auth.pullSettings).toHaveBeenCalledOnce()
  })

  it('keeps Settings open in signed-out state and announces local preservation after deletion', async () => {
    const auth = bridge({ getState: vi.fn().mockResolvedValue({ available: true, signedIn: true, email: 'person@example.com' }) })
    window.__CC_DESKTOP!.authState = { available: true, signedIn: true, email: 'person@example.com' }
    await act(async () => root.render(<AccountPanel />))
    await act(async () => {})
    await act(async () => button('Delete Account…').click())
    expect(auth.deleteAccount).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Local files and this Mac’s settings were not changed')
    expect(container.textContent).toContain('Continue with GitHub')
  })
})
