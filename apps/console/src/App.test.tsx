// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider } from './theme-mode'

let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '/?mode=demo#/canvas')
  window.localStorage.clear()
  delete window.__CC_DESKTOP
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  delete window.__CC_DESKTOP
  container.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('App settings surface', () => {
  it('keeps the app shell mounted and restores visible focus when Settings closes', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <StoreProvider><App /></StoreProvider>
      </ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const shell = container.querySelector('.cc-app-shell')
    expect(shell).toBeTruthy()
    const settings = button('Settings⌘,')
    settings.getBoundingClientRect = () => ({
      x: -300, y: 0, left: -300, top: 0, right: -260, bottom: 40, width: 40, height: 40, toJSON: () => ({}),
    })
    settings.focus()
    await act(async () => settings.click())

    expect(container.querySelector('.cc-settings-screen')).toBeTruthy()
    expect(container.querySelector('.cc-app-shell')).toBe(shell)
    expect(container.querySelector('.cc-app-layer')?.hasAttribute('inert')).toBe(true)

    await act(async () => button('Back to app').click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
    expect(container.querySelector('.cc-app-shell')).toBe(shell)
    expect(document.activeElement).toBe(container.querySelector('.cc-menu-btn'))
  })

  it('does not open Settings over the Connect Agent dialog', async () => {
    window.__CC_DESKTOP = {
      token: 'test',
      version: '0.1.0',
      authState: { signedIn: false },
      cli: {
        getStatus: vi.fn().mockResolvedValue({ status: 'installed', message: 'CLI is installed.' }),
        install: vi.fn().mockResolvedValue({ status: 'installed', message: 'CLI is installed.' }),
      },
    }
    await act(async () => root.render(
      <ThemeModeProvider>
        <StoreProvider><App /></StoreProvider>
      </ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    await act(async () => button('Connect an agent').click())
    expect(container.querySelector('.cc-connect-dialog')).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
    })
    expect(container.querySelector('.cc-connect-dialog')).toBeTruthy()
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
  })

  it('closes Settings without closing the preserved chat beneath it', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <StoreProvider><App /></StoreProvider>
      </ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    await act(async () => button('Ask ContextCake').click())
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeTruthy()
    await act(async () => button('Settings⌘,').click())

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeTruthy()
  })
})
