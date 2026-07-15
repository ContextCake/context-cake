import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { buildMenu } from './menu.mjs'
import { configDir, manifestPath, settingsPath } from './paths.mjs'
import { markSettingsDirty, readSettings, writeSettings } from './settings.mjs'
import { createAuthManager } from './auth.mjs'
import {
  assertSafeLocalSettings,
  combineManifestSources,
  createSettingsSync,
  overlaySyncShadow,
  selectManifestProfiles,
  selectSyncSettings,
} from './settings-sync.mjs'
import { loadSupabaseConfig } from './supabase-config.mjs'
import { initUpdater } from './updater.mjs'
import { isEngineOrigin, isTrustedIpcSender } from './navigation.mjs'
import { getCliStatus, installCli } from './cli-install.mjs'

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
let authManager = null
let settingsSync = null
let pendingDeepLink = null
let settingsPushTimer = null
let manifestWatchStarted = false
let lastAppliedManifest = ''

function currentAuthState() {
  return authManager?.getState() ?? { available: false, signedIn: false }
}

function currentSyncState() {
  return settingsSync?.getState() ?? { status: 'idle' }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function readManifestConfig() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  } catch {
    return {}
  }
}

function settingsSnapshot(settings = readSettings()) {
  const manifest = readManifestConfig()
  const { sources: _storedSources, profiles: _storedProfiles, ...preferences } = settings
  const currentUserId = authManager?.getUserId?.() ?? null
  const sources = combineManifestSources(
    manifest.layers,
    manifest.pendingSources,
    manifest.pendingSourcesOwnerUserId,
    currentUserId,
  )
  const profiles = selectManifestProfiles(
    manifest.profiles,
    manifest.profilesOwnerUserId,
    currentUserId,
  )
  const local = {
    ...preferences,
    ...(sources.length > 0 ? { sources } : {}),
    ...(profiles ? { profiles } : {}),
  }
  return {
    ...local,
    ...overlaySyncShadow(settings?._sync?.shadow, {
      ...local,
      _sync: {
        ...(settings?._sync ?? {}),
        currentUserId,
      },
    }, settings?._sync?.dirtyFields),
  }
}

function scheduleSettingsPush() {
  if (!currentAuthState().signedIn || !settingsSync) return
  clearTimeout(settingsPushTimer)
  settingsPushTimer = setTimeout(() => {
    settingsPushTimer = null
    settingsSync.push(settingsSnapshot()).catch(() => {})
  }, 750)
  settingsPushTimer.unref?.()
}

function sourceIsRunnable(source) {
  if (!source || typeof source !== 'object' || typeof source.name !== 'string' || !Number.isFinite(source.level)) return false
  const kind = source.source ?? 'okf-local'
  if (source.cache && (
    typeof source.cache !== 'object'
    || Array.isArray(source.cache)
    || (source.cache.dir !== undefined && typeof source.cache.dir !== 'string')
    || (source.cache.ttlSeconds !== undefined && !Number.isFinite(source.cache.ttlSeconds))
  )) return false
  if (kind === 'mcp') {
    return typeof source.command === 'string'
      && source.command.length > 0
      && (source.args === undefined || (Array.isArray(source.args) && source.args.every((arg) => typeof arg === 'string')))
  }
  if (kind !== 'okf-local' && kind !== 'files') return false
  return typeof source.path === 'string' && source.path.length > 0
}

function safeProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return null
  // Missing path/command fields represent integrations that need local setup.
  // Keep that non-executable profile structure so names and precedence arrive.
  return profiles
}

function applyPulledManifest(settings) {
  const current = readManifestConfig()
  const currentUserId = authManager?.getUserId?.() ?? null
  const incomingSources = Array.isArray(settings?.sources) ? settings.sources : null
  const layers = incomingSources ? incomingSources.filter(sourceIsRunnable) : current.layers
  const pendingSources = incomingSources ? incomingSources.filter((source) => !sourceIsRunnable(source)) : current.pendingSources
  const profiles = safeProfiles(settings?.profiles)
  const next = {
    ...current,
    ...(layers ? { layers } : {}),
    ...(pendingSources?.length ? { pendingSources, pendingSourcesOwnerUserId: currentUserId } : {}),
    ...(profiles ? { profiles, profilesOwnerUserId: currentUserId } : {}),
  }
  if (!pendingSources?.length) {
    delete next.pendingSources
    delete next.pendingSourcesOwnerUserId
  }
  if (isDeepStrictEqual(current, next)) return
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  const temporary = `${manifestPath()}.tmp`
  fs.writeFileSync(temporary, serialized, { mode: 0o600 })
  fs.renameSync(temporary, manifestPath())
  lastAppliedManifest = serialized
  service?.reload?.()
}

function publishPulledSettings(pulled) {
  if (!pulled) return
  applyPulledManifest(pulled.settings)
  sendToRenderer('settings:pulled', selectSyncSettings(pulled.settings))
  if (app.isReady()) {
    installApplicationMenu()
    initUpdater()
  }
}

function installApplicationMenu() {
  Menu.setApplicationMenu(buildMenu(
    () => win,
    () => {
      initUpdater()
      if (currentAuthState().signedIn) scheduleSettingsPush()
    },
  ))
}

function startManifestSync() {
  if (manifestWatchStarted) return
  manifestWatchStarted = true
  fs.watchFile(manifestPath(), { interval: 500 }, () => {
    let serialized
    try { serialized = fs.readFileSync(manifestPath(), 'utf8') } catch { return }
    if (serialized === lastAppliedManifest) {
      lastAppliedManifest = ''
      return
    }
    markSettingsDirty(['sources', 'profiles'])
    scheduleSettingsPush()
  })
}

async function syncAfterSignIn() {
  if (!settingsSync) return
  try {
    const pulled = await settingsSync.pull(settingsSnapshot())
    if (pulled) publishPulledSettings(pulled)
    else await settingsSync.push(settingsSnapshot())
  } catch {
    // Sync status is emitted separately. Local use and auth remain available.
  }
}

function openExternalHttps(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'https:') shell.openExternal(url.toString())
  } catch { /* ignore malformed renderer links */ }
}

function assertTrustedIpc(event) {
  if (!win || !service || !isTrustedIpcSender(event, win.webContents, service.origin)) {
    throw new Error('Untrusted IPC sender.')
  }
}

function handleTrustedIpc(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event)
    return callback(...args)
  })
}

async function handleDeepLink(url) {
  if (!authManager) {
    pendingDeepLink = url
    return
  }
  try {
    await authManager.handleDeepLink(url)
  } catch {
    sendToRenderer('auth:error', 'Sign-in could not be completed. Cancel this attempt, then try again.')
  }
}

function registerAccountIpc() {
  const handle = handleTrustedIpc

  handle('auth:get-state', currentAuthState)
  handle('auth:sign-in', (provider) => {
    if (provider === 'github') return authManager.signInWithGitHub()
    throw new Error('Unsupported sign-in provider.')
  })
  handle('auth:cancel-sign-in', () => authManager.cancelSignIn())
  handle('auth:sign-out', async () => {
    await authManager?.signOut()
    return currentAuthState()
  })
  handle('auth:delete-account', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete Account'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete ContextCake Account',
      message: 'Delete your account and synced settings?',
      detail: 'Your local ContextCake files and settings will stay on this Mac.',
    })
    if (response !== 1) return currentAuthState()
    await authManager?.deleteAccount()
    return currentAuthState()
  })
  handle('settings:sync-state', currentSyncState)
  handle('settings:push', async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings patch must be an object.')
    if (JSON.stringify(patch).length > 1_000_000) throw new Error('Settings patch is too large.')
    const selected = selectSyncSettings(patch)
    assertSafeLocalSettings(selected)
    writeSettings(selected)
    if (!currentAuthState().signedIn) return { localOnly: true }
    scheduleSettingsPush()
    return { localOnly: false }
  })
  handle('settings:pull', async () => {
    const pulled = await settingsSync?.pull(settingsSnapshot())
    publishPulledSettings(pulled)
    return pulled ? { overwritten: pulled.overwritten, settings: selectSyncSettings(pulled.settings) } : null
  })
  handle('settings:bootstrap-theme', async (localTheme) => {
    if (localTheme !== 'light' && localTheme !== 'dark') throw new Error('Invalid theme.')
    if (currentAuthState().signedIn) {
      const pulled = await settingsSync.pull(settingsSnapshot())
      publishPulledSettings(pulled)
    }
    const current = readSettings()
    if (current.theme === 'light' || current.theme === 'dark') return current.theme
    writeSettings({ theme: localTheme })
    scheduleSettingsPush()
    return localTheme
  })
}

async function initializeAccounts() {
  const packagedConfig = app.isPackaged ? path.join(process.resourcesPath, 'supabase-config.json') : ''
  const config = loadSupabaseConfig(configDir(), process.env, packagedConfig)
  authManager = createAuthManager({
    supabaseUrl: config.url,
    supabaseKey: config.anonKey,
    configDir: configDir(),
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
  })
  await authManager.initialize()
  settingsSync = createSettingsSync({
    authManager,
    supabaseClient: authManager.getClient(),
    localSettingsPath: settingsPath(),
    getCurrentSettings: () => settingsSnapshot(),
  })

  let wasSignedIn = currentAuthState().signedIn
  authManager.on('session-changed', (state) => {
    sendToRenderer('auth:session-changed', state)
    if (state.signedIn && !wasSignedIn) syncAfterSignIn()
    wasSignedIn = state.signedIn
  })
  settingsSync.on('status-changed', (state) => sendToRenderer('settings:sync-status', state))
  registerAccountIpc()

  if (pendingDeepLink) {
    const url = pendingDeepLink
    pendingDeepLink = null
    await handleDeepLink(url)
  }
}

// Fixed, argument-free IPC only. The sandboxed renderer can inspect or invoke
// ContextCake's own CLI installer; it cannot execute arbitrary processes or
// choose filesystem paths.
handleTrustedIpc('contextcake:cli-status', () => getCliStatus())
handleTrustedIpc('contextcake:cli-install', () => installCli(win, { showSuccess: false }))

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
        `--cc-signed-in=${currentAuthState().signedIn ? '1' : '0'}`,
      ],
    },
  })

  // The window only ever shows the local service; everything else opens in
  // the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isEngineOrigin(url, service.origin)) {
      event.preventDefault()
      openExternalHttps(url)
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    sendToRenderer('auth:session-changed', currentAuthState())
    sendToRenderer('settings:sync-status', currentSyncState())
  })
  win.on('closed', () => { win = null })
  await win.loadURL(`${service.origin}/console/`)
  startManifestSync()
}

async function smokeCheck() {
  // CC_SMOKE=1: boot, prove the service answers with the token, exit.
  // Used by CI and agents — no lingering window.
  try {
    // Exercise the wrapper used after a settings pull, not only HTTP reads.
    service.reload()
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
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

app.whenReady().then(async () => {
  await initializeAccounts()
  await createWindow()
  installApplicationMenu()
  initUpdater()
  if (currentAuthState().signedIn) await syncAfterSignIn()
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
  clearTimeout(settingsPushTimer)
  if (manifestWatchStarted) fs.unwatchFile(manifestPath())
  authManager?.close()
  service?.close()
  service = null
})
