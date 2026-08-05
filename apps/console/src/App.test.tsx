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

describe('Mac-first application shell', () => {
  it('opens an empty route on Home and exposes the five keyboard destinations', async () => {
    window.history.replaceState(null, '', '/?mode=demo')
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(container.querySelector('[data-destination="home"]')?.getAttribute('aria-current')).toBe('page')
    expect(window.location.hash).toBe('#/overview')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', metaKey: true, bubbles: true })))
    expect(container.querySelector('[data-destination="review"]')?.getAttribute('aria-current')).toBe('page')
    expect(button('Queue 3')).toBeTruthy()
    expect(button('Conflicts 3')).toBeTruthy()
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('')
  })

  it('opens the command palette with Command-K and restores focus after Escape', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const opener = container.querySelector<HTMLButtonElement>('.cc-toolbar-leading button')!
    opener.focus()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })))
    expect(container.querySelector('[aria-label="Command palette"]')).toBeTruthy()
    expect(document.activeElement).toBe(container.querySelector('.cc-command-palette input'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(container.querySelector('[aria-label="Command palette"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('restores the pre-palette opener after running Ask from the palette', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const opener = container.querySelector<HTMLButtonElement>('.cc-toolbar-leading button')!
    opener.focus()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('.cc-command-palette input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'ask')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeTruthy()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('exposes wide Ask as a nonmodal complementary pane', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(min-width: 1280px)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })))
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => button('Ask').click())
    const ask = container.querySelector('[aria-label="Ask ContextCake"]')
    expect(ask?.getAttribute('role')).toBe('complementary')
    expect(ask?.hasAttribute('aria-modal')).toBe(false)
  })

  it('focuses contextual search with Command-F and clears it with Escape', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => button('Knowledge').click())
    const concept = container.querySelector<HTMLButtonElement>('.cc-navigator-detail > div button')
    await act(async () => concept?.click())
    expect(container.querySelector('.cc-navigator-detail-panel[data-open]')).toBeTruthy()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })))
    const search = container.querySelector<HTMLInputElement>('input[data-context-search]')
    expect(document.activeElement).toBe(search)

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'auth')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(search?.value).toBe('auth')
    await act(async () => search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(search?.value).toBe('')
    expect(container.querySelector('.cc-navigator-detail-panel[data-open]')).toBeTruthy()
  })

  it('routes every shell navigation path through the unsaved-work guard', async () => {
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const guard = (event: Event) => event.preventDefault()
    window.addEventListener('contextcake:before-navigate', guard)
    await act(async () => button('Home').click())
    expect(container.querySelector('[data-destination="cascade"]')?.getAttribute('aria-current')).toBe('page')
    window.removeEventListener('contextcake:before-navigate', guard)
  })

  it('uses five destinations and supports the 64–300 px sidebar contract', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <StoreProvider><App /></StoreProvider>
      </ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const sidebar = container.querySelector<HTMLElement>('.cc-sidebar')
    const brand = container.querySelector('.cc-brand')
    const separator = container.querySelector<HTMLElement>('.cc-sidebar-resizer')
    expect(brand?.querySelector('img')).toBeTruthy()
    expect(brand?.textContent).toBe('ContextCake')
    expect(container.querySelectorAll('.cc-nav-button')).toHaveLength(5)
    expect(sidebar?.dataset.collapsed).toBe('false')
    expect(sidebar?.style.width).toBe('232px')

    await act(async () => {
      separator?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 232 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 80 }))
    })
    expect(sidebar?.dataset.collapsed).toBe('true')
    expect(sidebar?.style.width).toBe('64px')
    expect(container.querySelector('[data-destination="review"]')?.getAttribute('aria-label')).toBe('Review, 6 items needing review')

    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
    })
    expect(sidebar?.dataset.collapsed).toBe('true')
    expect(sidebar?.style.width).toBe('64px')

    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })
    expect(sidebar?.dataset.collapsed).toBe('false')
    expect(sidebar?.style.width).toBe('232px')
    expect(JSON.parse(window.localStorage.getItem('contextcake.sidebar') ?? '{}')).toEqual({ collapsed: false, width: 232 })

    await act(async () => {
      separator?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 232 }))
    })
    expect(document.body.style.cursor).toBe('col-resize')
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

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

    await act(async () => button('Close').click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
    expect(container.querySelector('.cc-app-shell')).toBe(shell)
    expect(document.activeElement).toBe(container.querySelector('.cc-toolbar-leading button'))
  })

  it('does not open Settings over the Connect Agent dialog', async () => {
    window.__CC_DESKTOP = {
      getApiToken: async () => 'test',
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

    await act(async () => button('Sources').click())
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Agent"]')?.click())
    expect(container.querySelector('.cc-connect-dialog')).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
    })
    expect(container.querySelector('.cc-connect-dialog')).toBeTruthy()
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
  })

  it('opens desktop Settings as a separate native window instead of mounting the overlay', async () => {
    const openSettings = vi.fn().mockResolvedValue({ opened: true, existing: false })
    window.__CC_DESKTOP = {
      getApiToken: async () => 'test', version: '0.1.0', authState: { signedIn: false },
      windows: { openSettings, onSettingsPane: vi.fn(() => () => {}) },
      data: { requestReload: vi.fn(), onReloadRequested: vi.fn(() => () => {}) },
      cli: { getStatus: vi.fn(), install: vi.fn() },
    }
    await act(async () => root.render(<ThemeModeProvider><StoreProvider><App /></StoreProvider></ThemeModeProvider>))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => button('Settings⌘,').click())
    expect(openSettings).toHaveBeenCalledWith()
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
  })

  it('closes Settings without closing the preserved chat beneath it', async () => {
    await act(async () => root.render(
      <ThemeModeProvider>
        <StoreProvider><App /></StoreProvider>
      </ThemeModeProvider>,
    ))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    await act(async () => button('Ask').click())
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeTruthy()
    await act(async () => button('Settings⌘,').click())

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.cc-settings-screen')).toBeNull()
    expect(container.querySelector('[aria-label="Ask ContextCake"]')).toBeTruthy()
  })
})
