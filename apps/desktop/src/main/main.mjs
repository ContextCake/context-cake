import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { buildMenu } from './menu.mjs'
import { initUpdater } from './updater.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// A dead stdout/stderr pipe (the launching terminal or parent process went
// away) must never escalate into an uncaught EPIPE and Electron's raw crash
// dialog — a GUI app outlives its console. Swallow those writes.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {})
}

// Any failure to boot — the engine service can't bind, a packaged path is
// wrong, the config dir isn't writable — becomes a clean, logged, fast exit
// with a plain-language dialog, never a hang with no window or a raw stack
// trace. In smoke/CI mode we skip the modal and just exit non-zero so the
// job fails fast instead of blocking to timeout.
function handleFatal(err) {
  if (err && err.code === 'EPIPE') return
  const detail = (err && err.stack) || String(err)
  // Synchronous write: app.exit() below is abrupt and would race an async
  // console.error, so the diagnostic (and CI's grep for it) could be lost.
  try { fs.writeSync(2, `[contextcake] fatal: ${detail}\n`) } catch { /* stderr gone */ }
  if (process.env.CC_SMOKE !== '1' && app.isReady()) {
    dialog.showErrorBox(
      'ContextCake could not start',
      'The local engine failed to start. Please reopen ContextCake. If this keeps '
        + 'happening, report it at github.com/ContextCake/context-cake/issues.\n\n'
        + detail,
    )
  }
  app.exit(1)
}

process.on('uncaughtException', handleFatal)
process.on('unhandledRejection', handleFatal)

// Pin the app name BEFORE anything reads a userData path (the single-instance
// lock below already does). Electron otherwise derives the name from
// package.json — "contextcake-desktop" in dev, and electron-builder does not
// inject productName into the packaged package.json — so userData would land
// at …/contextcake-desktop/ while the CLI (src/cli/cli.mjs) reads
// …/Application Support/ContextCake/. Both sides MUST agree or `contextcake
// mcp` can't find the manifest the app wrote. Keep this string, the CLI's
// CONFIG_DIR, and package.json's productName identical.
app.setName('ContextCake')

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
    // Guard the app-name/CLI agreement: userData must resolve under a dir named
    // "ContextCake" so `contextcake mcp` finds the manifest the app wrote.
    const userDataName = path.basename(app.getPath('userData'))
    const okName = userDataName === 'ContextCake'
    if (res.ok && unauth.status === 401 && okName) {
      console.log(`SMOKE OK ${service.origin} api=200 unauth=401 userData=${userDataName}`)
      app.exit(0)
    } else {
      console.error(`SMOKE FAIL api=${res.status} unauth=${unauth.status} userData=${userDataName}`)
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
}).catch(handleFatal)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(handleFatal)
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
