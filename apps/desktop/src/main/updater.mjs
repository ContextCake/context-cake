// Auto-update via electron-updater against GitHub Releases (app-v* tags) —
// the single authoritative version source (specs/contextcake-distribution/
// design.md §7). Privacy: the check hits github.com with version/platform
// only, and readSettings().updateCheck turns it off entirely.
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { readSettings } from './settings.mjs'
import { statSync } from 'node:fs'
import path from 'node:path'
import { readPackageType } from './package-type.mjs'

const { autoUpdater } = electronUpdater
const SIX_HOURS = 6 * 60 * 60 * 1000

// ---- Package-managed installs (.deb) ----------------------------------------
//
// A .deb belongs to the system's package manager. electron-updater's
// DebUpdater would download the next .deb and run `dpkg -i` through pkexec or
// sudo, which is neither ours to do nor verified against a key we hold
// (distribution design §11.4). So when electron-builder recorded the install
// as a deb, the updater only checks: it never downloads, never installs on
// quit, and reports `available` with a link to the release instead.
const NOTIFY_ONLY_PACKAGES = new Set(['deb'])

function notifyOnly() {
  return app.isPackaged && NOTIFY_ONLY_PACKAGES.has(readPackageType(process.resourcesPath))
}

export function releaseUrl(version) {
  return `https://github.com/ContextCake/context-cake/releases/tag/app-v${version}`
}

// Set before every check, not once: autoDownload defaults to true, and a manual
// check can run while automatic checks (initUpdater) are switched off.
function configureUpdater() {
  if (notifyOnly()) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
  } else {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
  }
}

let timer = null
let quitHookRegistered = false

// ---- Renderer-facing status (Settings → "Check for Updates" / "Update Now") -
//
// Separate from checkInteractive()'s native dialogs on purpose: the Settings
// pane wants a persistent, pollable status a user can look at after opening
// the window, not a one-shot dialog. Both paths drive the same autoUpdater
// singleton, so a check started from either surface updates both.
let status = { state: 'unsupported' }
let notify = null
let rendererListenersRegistered = false

function setStatus(next) {
  status = next
  notify?.('updates:status', status)
  return status
}

function unsupportedBuildStatus() {
  if (!app.isPackaged) return { state: 'unsupported', reason: 'development-build' }
  // electron-builder --dir produces a runnable local .app without a release
  // feed. isPackaged alone doesn't mean electron-updater can check it. Only
  // missing metadata is unsupported; malformed/unreadable release metadata
  // must still surface the updater's real error rather than hiding it.
  try { statSync(path.join(process.resourcesPath, 'app-update.yml')) }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'unsupported', reason: 'missing-update-metadata' }
  }
  return null
}

export function initUpdater() {
  // KNOWN CONSTRAINT (tracked): electron-updater's GitHub provider reads
  // github.com/ContextCake/context-cake/releases/latest for the WHOLE repo. If
  // a non-app release becomes "latest", latest-mac.yml
  // 404s and the check fails (handled gracefully below — never crashes). Until a
  // dedicated update channel/feed lands, only app-release.yml may publish full
  // GitHub Releases; other release notes must be drafts or prereleases.
  //
  const unsupported = unsupportedBuildStatus()
  if (unsupported) {
    if (timer) clearInterval(timer)
    timer = null
    setStatus(unsupported)
    return
  }
  if (!readSettings().updateCheck) {
    if (timer) clearInterval(timer)
    timer = null
    return
  }
  if (timer) return

  configureUpdater()

  const check = () => {
    if (!readSettings().updateCheck) return
    configureUpdater()
    // checkForUpdatesAndNotify's OS notification announces a finished
    // download, which a notify-only install never has; its status comes
    // through the `update-available` event instead.
    const run = notifyOnly() ? autoUpdater.checkForUpdates() : autoUpdater.checkForUpdatesAndNotify()
    Promise.resolve(run).catch((err) => {
      console.error('[updater]', err?.message ?? err)
    })
  }
  check()
  timer = setInterval(check, SIX_HOURS)
  if (!quitHookRegistered) {
    quitHookRegistered = true
    app.on('before-quit', () => timer && clearInterval(timer))
  }
}

/** Menu-driven "Check for Updates…" with explicit result dialogs. */
export async function checkInteractive(win) {
  const unsupported = unsupportedBuildStatus()
  if (unsupported) {
    setStatus(unsupported)
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates are unavailable in this local build.',
      detail: 'Install a published ContextCake release to receive app updates.',
    })
    return
  }
  try {
    configureUpdater()
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version
    if (!latest || latest === app.getVersion()) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: `You're up to date.`,
        detail: `ContextCake ${app.getVersion()} is the latest version.`,
      })
      return
    }
    if (notifyOnly()) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: `ContextCake ${latest} is available.`,
        detail: 'This copy was installed from a .deb package, so your package manager installs updates. Download the new package, then install it the way you installed this one.',
        buttons: ['Open Download Page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await shell.openExternal(releaseUrl(latest))
      return
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `ContextCake ${latest} is available.`,
      detail: 'The update downloads in the background. Relaunch to apply it.',
      buttons: ['Relaunch to Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      autoUpdater.quitAndInstall()
    }
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Could not check for updates.',
      detail: String(err?.message ?? err),
    })
  }
}

/**
 * Wire autoUpdater's events into `status` and push each change to every
 * trusted renderer via `notifyFn` (main.mjs's `sendToRenderer`). Idempotent
 * and safe to call more than once — only the first call in a packaged app
 * attaches listeners; local builds without a release feed stay `unsupported`.
 */
export function registerRendererUpdates(notifyFn) {
  notify = notifyFn
  const unsupported = unsupportedBuildStatus()
  if (unsupported) { setStatus(unsupported); return }
  if (rendererListenersRegistered) return
  rendererListenersRegistered = true
  status = { state: 'idle' }
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setStatus(notifyOnly()
    ? { state: 'available', version: info?.version, url: releaseUrl(info?.version) }
    : { state: 'downloading', version: info?.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (progress) => setStatus({ state: 'downloading', version: status.version, percent: Math.round(progress?.percent ?? 0) }))
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info?.version ?? status.version }))
  autoUpdater.on('error', (err) => setStatus({ state: 'error', error: String(err?.message ?? err) }))
}

/** Current status for a renderer that just opened Settings and missed earlier events. */
export function getUpdateStatus() {
  return unsupportedBuildStatus() ?? status
}

/**
 * Renderer-initiated check (the Settings "Check for Updates" button). Ignores
 * the `updateCheck` preference on purpose — same as checkInteractive() — a
 * manual check is a distinct action from the periodic background one.
 */
export async function checkForUpdatesFromRenderer() {
  const unsupported = unsupportedBuildStatus()
  if (unsupported) return setStatus(unsupported)
  setStatus({ state: 'checking' })
  try {
    configureUpdater()
    await autoUpdater.checkForUpdates()
    return status
  } catch (err) {
    return setStatus({ state: 'error', error: String(err?.message ?? err) })
  }
}

/**
 * The Settings "Update Now" button. A no-op unless a download actually
 * completed. Confirms with the same native dialog checkInteractive() already
 * uses for the menu path — quitAndInstall() is an instant, unprompted quit
 * otherwise, which would blindside a user mid-task and (an adversarial review
 * on PR #128 flagged this) gives any script running in a trusted renderer an
 * unconfirmed way to force the app to quit.
 */
export async function installNow(win) {
  if (unsupportedBuildStatus() || notifyOnly() || status.state !== 'downloaded') return { installed: false }
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: `ContextCake ${status.version ? `${status.version} ` : ''}is ready to install.`,
    detail: 'ContextCake will quit and relaunch to apply the update.',
    buttons: ['Relaunch to Update', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return { installed: false }
  autoUpdater.quitAndInstall()
  return { installed: true }
}
