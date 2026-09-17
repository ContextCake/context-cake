// Which operating system the console is drawing for, and the words and glyphs
// that follow from it.
//
// Inside the desktop app the preload says (`__CC_DESKTOP.platform`, Node's
// process.platform), which is exact. In a browser (the Web Demo, the playground)
// the best signal is the navigator. Every answer is a function, not a module
// constant, because the desktop bridge is read at call time.

type DesktopPlatform = 'darwin' | 'linux' | 'win32' | string

function desktopPlatform(): DesktopPlatform | undefined {
  const desktop = typeof window === 'undefined' ? undefined : window.__CC_DESKTOP
  if (!desktop) return undefined
  // A desktop bridge without `platform` is an app from before the Linux build,
  // which only ever shipped for macOS.
  return desktop.platform ?? 'darwin'
}

/** True on macOS and iOS, where shortcuts use ⌘ and files open in Finder. */
export function isApplePlatform(): boolean {
  const desktop = desktopPlatform()
  if (desktop) return desktop === 'darwin'
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/** True inside the macOS desktop app, where macOS-only features (Local Grafana) exist. */
export function isMacDesktop(): boolean {
  return desktopPlatform() === 'darwin'
}

// Every binding is CmdOrCtrl (App.tsx tests `e.metaKey || e.ctrlKey`;
// menu.mjs uses `CmdOrCtrl+`), so the glyph is the platform's, not a hardcoded
// ⌘. Printing ⌘ on Linux or Windows documents a chord nobody there can press.
export function modKey(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl+'
}

export function shiftModKey(): string {
  return isApplePlatform() ? '⇧⌘' : 'Ctrl+Shift+'
}

/** A CmdOrCtrl shortcut label: `shortcut('K')` is ⌘K on a Mac and Ctrl+K elsewhere. */
export function shortcut(key: string, { shift = false }: { shift?: boolean } = {}): string {
  return `${shift ? shiftModKey() : modKey()}${key}`
}

// The two below change wording only inside a non-Mac desktop app. The Web Demo
// and the playground keep the Mac app's copy, which is what they describe.

/** What "Show in …" opens: Finder, or the Linux desktop's file manager. */
export function fileManagerName(): string {
  const desktop = desktopPlatform()
  return desktop && desktop !== 'darwin' ? 'Files' : 'Finder'
}

/** "this Mac", or "this computer" in the Linux app, for copy about local state. */
export function thisDevice(): string {
  const desktop = desktopPlatform()
  return desktop && desktop !== 'darwin' ? 'this computer' : 'this Mac'
}

/**
 * Where the desktop app keeps settings and logs, as the main process resolved
 * them. An app too old to report paths only ever shipped for macOS.
 */
export function desktopDataPaths(): { config: string; logs: string } {
  const reported = typeof window === 'undefined' ? undefined : window.__CC_DESKTOP?.paths
  return {
    config: reported?.config || '~/Library/Application Support/ContextCake',
    logs: reported?.logs || '~/Library/Logs/ContextCake',
  }
}
