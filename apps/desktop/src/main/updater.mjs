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

export function initUpdater() {
  // Unsigned dev builds can't apply updates; don't even check.
  if (!app.isPackaged) return
  if (!readSettings().updateCheck) return

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
  app.on('before-quit', () => timer && clearInterval(timer))
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
