import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { buildMenu } from './menu.mjs'
import { initUpdater } from './updater.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Deep-link scheme for OAuth callbacks (specs/contextcake-auth/spec.md).
// Registered for packaged builds only — in dev it would bind the bare
// Electron binary system-wide.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient('contextcake')
}

let service = null
let win = null

async function createWindow() {
  service ??= await startEngineService()

  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--cc-token=${service.token}`,
        `--cc-version=${app.getVersion()}`,
      ],
    },
  })

  // The window only ever shows the local service; everything else opens in
  // the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(service.origin)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
  await win.loadURL(`${service.origin}/console/`)
}

async function smokeCheck() {
  // CC_SMOKE=1: boot, prove the service answers with the token, exit.
  // Used by CI and agents — no lingering window.
  try {
    const res = await fetch(`${service.origin}/api/graph`, {
      headers: { authorization: `Bearer ${service.token}` },
    })
    const unauth = await fetch(`${service.origin}/api/graph`)
    if (res.ok && unauth.status === 401) {
      console.log(`SMOKE OK ${service.origin} api=200 unauth=401`)
      app.exit(0)
    } else {
      console.error(`SMOKE FAIL api=${res.status} unauth=${unauth.status}`)
      app.exit(1)
    }
  } catch (err) {
    console.error('SMOKE FAIL', err?.message ?? err)
    app.exit(1)
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// OAuth deep-link callbacks land here; consumed by the auth broker in Phase 2.
app.on('open-url', (event) => {
  event.preventDefault()
})

app.whenReady().then(async () => {
  await createWindow()
  Menu.setApplicationMenu(buildMenu(() => win))
  initUpdater()
  if (process.env.CC_SMOKE === '1') await smokeCheck()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  // Menu-bar-less background mode isn't a thing yet; quitting keeps the
  // service lifecycle simple. The CLI works with the app closed.
  app.quit()
})

app.on('before-quit', () => {
  service?.close()
  service = null
})
