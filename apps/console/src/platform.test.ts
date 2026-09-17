// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopDataPaths, fileManagerName, isApplePlatform, isMacDesktop, shortcut, thisDevice } from './platform'

function desktop(platform?: string) {
  window.__CC_DESKTOP = { getApiToken: async () => 't', version: '0', authState: { signedIn: false }, cli: { getStatus: vi.fn(), install: vi.fn() }, ...(platform ? { platform } : {}) }
}

afterEach(() => {
  delete window.__CC_DESKTOP
  vi.restoreAllMocks()
})

describe('platform', () => {
  it('the Linux app gets Ctrl shortcuts, Files, XDG paths, and no Mac wording', () => {
    desktop('linux')
    expect(isApplePlatform()).toBe(false)
    expect(isMacDesktop()).toBe(false)
    expect(shortcut('K')).toBe('Ctrl+K')
    expect(shortcut('F', { shift: true })).toBe('Ctrl+Shift+F')
    expect(fileManagerName()).toBe('Files')
    expect(thisDevice()).toBe('this computer')
    expect(desktopDataPaths()).toEqual({ config: '~/.config/contextcake', logs: '~/.config/contextcake/logs' })
  })

  it('the Mac app, and an older app that predates the platform field, keep the Mac wording', () => {
    for (const platform of ['darwin', undefined]) {
      desktop(platform)
      expect(isApplePlatform()).toBe(true)
      expect(isMacDesktop()).toBe(true)
      expect(shortcut(',')).toBe('⌘,')
      expect(fileManagerName()).toBe('Finder')
      expect(thisDevice()).toBe('this Mac')
      expect(desktopDataPaths().config).toBe('~/Library/Application Support/ContextCake')
    }
  })

  it('a browser picks shortcut glyphs from the navigator and keeps the Web Demo copy', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    expect(shortcut('1')).toBe('Ctrl+1')
    expect(isMacDesktop()).toBe(false)
    // Wording about the app is unchanged outside a non-Mac desktop app.
    expect(fileManagerName()).toBe('Finder')
    expect(thisDevice()).toBe('this Mac')

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(shortcut('1')).toBe('⌘1')
  })
})
