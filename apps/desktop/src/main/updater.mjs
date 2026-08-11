// Auto-update via electron-updater against GitHub Releases (app-v* tags) —
// the single authoritative version source (specs/contextcake-distribution/
// design.md §7). Privacy: the check hits github.com with version/platform
// only, and readSettings().updateCheck turns it off entirely.
import { app, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { readSettings } from './settings.mjs'

const { autoUpdater } = electronUpdater
const SIX_HOURS = 6 * 60 * 60 * 1000

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

export function initUpdater() {
  // KNOWN CONSTRAINT (tracked): electron-updater's GitHub provider reads
  // github.com/ContextCake/context-cake/releases/latest for the WHOLE repo. If
  // a non-app release becomes "latest", latest-mac.yml
  // 404s and the check fails (handled gracefully below — never crashes). Until a
  // dedicated update channel/feed lands, only app-release.yml may publish full
  // GitHub Releases; other release notes must be drafts or prereleases.
  //
  // Unsigned dev builds can't apply updates; don't even check.
  if (!app.isPackaged) return
  if (!readSettings().updateCheck) {
    if (timer) clearInterval(timer)
    timer = null
    return
  }
  if (timer) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const check = () => {
    if (!readSettings().updateCheck) return
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
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
  if (!app.isPackaged) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates are unavailable in development builds.',
    })
    return
  }
  try {
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
 * attaches listeners; unpackaged builds stay `unsupported` forever, since
 * unsigned dev builds can't apply an update anyway (see initUpdater above).
 */
export function registerRendererUpdates(notifyFn) {
  notify = notifyFn
  if (rendererListenersRegistered || !app.isPackaged) return
  rendererListenersRegistered = true
  status = { state: 'idle' }
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'downloading', version: info?.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (progress) => setStatus({ state: 'downloading', version: status.version, percent: Math.round(progress?.percent ?? 0) }))
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info?.version ?? status.version }))
  autoUpdater.on('error', (err) => setStatus({ state: 'error', error: String(err?.message ?? err) }))
}

/** Current status for a renderer that just opened Settings and missed earlier events. */
export function getUpdateStatus() {
  return app.isPackaged ? status : { state: 'unsupported' }
}

/**
 * Renderer-initiated check (the Settings "Check for Updates" button). Ignores
 * the `updateCheck` preference on purpose — same as checkInteractive() — a
 * manual check is a distinct action from the periodic background one.
 */
export async function checkForUpdatesFromRenderer() {
  if (!app.isPackaged) return setStatus({ state: 'unsupported' })
  setStatus({ state: 'checking' })
  try {
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
  if (status.state !== 'downloaded') return { installed: false }
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
