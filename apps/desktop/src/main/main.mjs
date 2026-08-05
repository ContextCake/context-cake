import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { createGithubConnections, verifyGithubToken } from './github-connections.mjs'
import { buildMenu } from './menu.mjs'
import { configDir, manifestPath, settingsPath } from './paths.mjs'
import { markSettingsDirty, readSettings, writeLocalSettings, writeSettings } from './settings.mjs'
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
import { reportFirstLaunch } from './install-metrics.mjs'
import { manifestLayerCount, shouldDeferConsentPrompt } from './metrics-consent.mjs'
import { changedPreferencePatch } from './preferences.mjs'
import { applyUiStatePatch, normalizeUiState } from './ui-state.mjs'
import { restoreWindowState } from './window-state.mjs'

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
  // Stop the engine child first. app.exit() below skips before-quit, so
  // without this its teardown would look like an unexpected exit and report a
  // second, misleading failure.
  shutdownEngine()
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

/**
 * Stop the engine process and stop treating its exit as a crash. Every path
 * that ends the app — before-quit, a fatal error, the smoke check's app.exit —
 * must go through this, because app.exit() does not fire before-quit.
 */
function shutdownEngine() {
  try { service?.close() } catch { /* already down */ }
  service = null
}

let authManager = null
let settingsSync = null
let pendingDeepLink = null
let settingsPushTimer = null
let manifestWatchStarted = false
let lastAppliedManifest = ''
let installMetricAbortController = null
let consentPromptDeferred = false
let windowStateTimer = null

function currentAuthState() {
  return authManager?.getState() ?? { available: false, signedIn: false }
}

function currentSyncState() {
  return settingsSync?.getState() ?? { status: 'idle' }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function desktopPreferencesSnapshot(settings = readSettings()) {
  const theme = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
  const density = ['comfortable', 'compact'].includes(settings.density) ? settings.density : 'comfortable'
  return {
    theme,
    density,
    updateCheck: settings.updateCheck !== false,
    anonymousMetrics: typeof settings.anonymousMetrics === 'boolean' ? settings.anonymousMetrics : null,
    reducedTransparency: nativeTheme.prefersReducedTransparency === true,
    highContrast: nativeTheme.shouldUseHighContrastColors === true,
  }
}

function applyNativeAppearance(settings = readSettings()) {
  const preferences = desktopPreferencesSnapshot(settings)
  nativeTheme.themeSource = preferences.theme
  sendToRenderer('preferences:changed', preferences)
  return preferences
}

function uiStateSnapshot(settings = readSettings()) {
  return normalizeUiState(settings.uiState)
}

function saveWindowState(window) {
  if (!window || window.isDestroyed() || window.isFullScreen()) return
  const maximized = window.isMaximized()
  const bounds = maximized ? window.getNormalBounds() : window.getBounds()
  writeLocalSettings({ mainWindow: { bounds, maximized } })
}

function scheduleWindowStateSave(window) {
  clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null
    saveWindowState(window)
  }, 250)
  windowStateTimer.unref?.()
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
  const currentUserId = authManager?.getUserId?.() ?? null
  const incomingSources = Array.isArray(settings?.sources) ? settings.sources : null
  const profiles = safeProfiles(settings?.profiles)
  const mutation = service.mutateManifest((current) => {
    const layers = incomingSources ? incomingSources.filter(sourceIsRunnable) : current.layers
    const pendingSources = incomingSources ? incomingSources.filter((source) => !sourceIsRunnable(source)) : current.pendingSources
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
    return isDeepStrictEqual(current, next) ? null : next
  })
  if (!mutation.changed) return
  lastAppliedManifest = mutation.serialized
  service?.reload?.()
}

function publishPulledSettings(pulled) {
  if (!pulled) return
  applyPulledManifest(pulled.settings)
  sendToRenderer('settings:pulled', selectSyncSettings(pulled.settings))
  applyNativeAppearance()
  if (app.isReady()) {
    installApplicationMenu()
    initUpdater()
  }
}

function installApplicationMenu() {
  Menu.setApplicationMenu(buildMenu(
    () => win,
    (settings, changedField) => {
      initUpdater()
      if (changedField === 'anonymousMetrics') {
        if (settings.anonymousMetrics === true) reportAnonymousFirstLaunch()
        else cancelAnonymousFirstLaunch()
      } else if (currentAuthState().signedIn) {
        scheduleSettingsPush()
      }
    },
  ))
}

function reportAnonymousFirstLaunch() {
  const settings = readSettings()
  if (settings.anonymousMetrics !== true) return Promise.resolve({ status: 'disabled' })
  if (!installMetricAbortController || installMetricAbortController.signal.aborted) {
    installMetricAbortController = new AbortController()
  }
  const controller = installMetricAbortController
  return reportFirstLaunch({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    configDir: configDir(),
    metricsEnabled: true,
    signal: controller.signal,
  }).finally(() => {
    if (installMetricAbortController === controller) installMetricAbortController = null
  }).then((result) => {
    // If the user opted out and immediately opted back in while the abort was
    // settling, honor the final local choice without overlapping requests.
    if (result.status === 'cancelled' && readSettings().anonymousMetrics === true) {
      return reportAnonymousFirstLaunch()
    }
    return result
  })
}

function cancelAnonymousFirstLaunch() {
  installMetricAbortController?.abort()
  installMetricAbortController = null
}

async function ensureAnonymousMetricsPreference() {
  const current = readSettings().anonymousMetrics
  if (typeof current === 'boolean') return current

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Anonymous Usage Metrics',
    message: 'Help improve ContextCake?',
    detail: 'ContextCake can download one tiny file from GitHub to share the app version and a one-time signal when it opens successfully. We use this anonymous information to understand adoption and improve the app. GitHub receives ordinary download request metadata, including the network address used to connect. The request never includes your files, paths, prompts, account details, or a device ID. You can change this anytime in Settings.',
    buttons: ['Share Anonymous Metrics', "Don't Share"],
    defaultId: 1,
    cancelId: 1,
  })
  const enabled = response === 0
  try {
    writeLocalSettings({ anonymousMetrics: enabled })
  } catch {
    // A metrics-only preference must never turn a writable-settings problem
    // into a fatal app startup. Without a persisted opt-in, do not report.
    return false
  }
  return enabled
}

// Deferred first-run consent (see the whenReady bootstrap): once the manifest
// gains its first layer, ask — and on accept, report immediately, exactly as
// the boot-time path does. Main-process-only; the renderer is never involved.
function maybeShowDeferredConsent() {
  if (!consentPromptDeferred) return
  if (manifestLayerCount(readManifestConfig()) === 0) return
  consentPromptDeferred = false
  ensureAnonymousMetricsPreference()
    .then(() => {
      installApplicationMenu()
      return reportAnonymousFirstLaunch()
    })
    .catch(() => {})
}

function startManifestSync() {
  if (manifestWatchStarted) return
  manifestWatchStarted = true
  fs.watchFile(manifestPath(), { interval: 500 }, () => {
    let serialized
    try { serialized = fs.readFileSync(manifestPath(), 'utf8') } catch { return }
    // Consent sequencing watches for the first layer regardless of who wrote
    // it (wizard, settings pull, hand edit) — check before the self-write
    // short-circuit below.
    maybeShowDeferredConsent()
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

// ---- GitHub integration credentials -----------------------------------------
//
// Independent of accounts on purpose: reading your own private repo must not
// require a ContextCake sign-in. The store lives in the main process; the
// renderer only ever sees metadata (see list()), and the secrets reach the
// engine over its message port, never argv or env.

let githubConnections = null

function connections() {
  githubConnections ??= createGithubConnections({ configDir: configDir(), safeStorage })
  return githubConnections
}

async function pushGithubTokens() {
  if (!service?.sendTokens) return
  try {
    await service.sendTokens(connections().injectionMap())
  } catch {
    // Never surface the payload in an error path.
    console.error('[contextcake] could not hand credentials to the engine')
  }
}

function registerIntegrationIpc() {
  const handle = handleTrustedIpc
  handle('integrations:list', () => connections().list())
  handle('integrations:add-token', async ({ token, host } = {}) => {
    // Verify before storing: it names the account (so the alias reflects the
    // real login) and turns a typo into a clear message instead of a layer
    // that silently reads as empty later.
    const { login, gitHost } = await verifyGithubToken({ token, host })
    const added = connections().add({ login, token, host: gitHost, tokenType: 'pat' })
    await pushGithubTokens()
    return added
  })
  handle('integrations:disconnect', async (alias) => {
    const removed = connections().remove(String(alias ?? ''))
    if (removed) await pushGithubTokens()
    return { removed }
  })
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
    // Startup can finish an OAuth deep link before the engine service exists.
    // The post-createWindow bootstrap below performs that first pull; only
    // already-running app sessions sync immediately from this event.
    if (state.signedIn && !wasSignedIn && service) syncAfterSignIn()
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

// Native shell IPC is fixed-purpose and protected by the same exact-window,
// exact-origin check as account IPC. The renderer cannot execute arbitrary
// processes or select a path without the user approving the native panel.
// Registered here rather than inside initializeAccounts(): connecting GitHub
// works in a build that ships no accounts at all, and that independence should
// be structural rather than a coincidence of call order.
registerIntegrationIpc()

handleTrustedIpc('contextcake:cli-status', () => getCliStatus())
handleTrustedIpc('contextcake:cli-install', () => installCli(win, { showSuccess: false }))
handleTrustedIpc('preferences:get', () => desktopPreferencesSnapshot())
handleTrustedIpc('preferences:set', (candidate) => {
  const current = readSettings()
  const changed = changedPreferencePatch(current, candidate)
  if (Object.keys(changed).length === 0) return desktopPreferencesSnapshot(current)

  const { anonymousMetrics, ...synced } = changed
  let next = current
  if (Object.keys(synced).length > 0) next = writeSettings(synced)
  if (anonymousMetrics !== undefined) next = writeLocalSettings({ anonymousMetrics })

  const preferences = applyNativeAppearance(next)
  if (Object.hasOwn(changed, 'updateCheck')) initUpdater()
  if (anonymousMetrics !== undefined) {
    installApplicationMenu()
    if (anonymousMetrics) reportAnonymousFirstLaunch()
    else cancelAnonymousFirstLaunch()
  }
  if (Object.keys(synced).length > 0) scheduleSettingsPush()
  return preferences
})
handleTrustedIpc('ui-state:set', (patch) => {
  const currentSettings = readSettings()
  const result = applyUiStatePatch(currentSettings.uiState, patch)
  if (result.changed) writeLocalSettings({ uiState: result.state })
  return result.state
})
handleTrustedIpc('contextcake:metrics-get', () => {
  const enabled = readSettings().anonymousMetrics
  return typeof enabled === 'boolean' ? enabled : null
})
handleTrustedIpc('contextcake:metrics-set', (enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Anonymous metrics preference must be a boolean.')
  writeLocalSettings({ anonymousMetrics: enabled })
  installApplicationMenu()
  if (enabled) reportAnonymousFirstLaunch()
  else cancelAnonymousFirstLaunch()
  return enabled
})
// The API token is a credential: never put it in BrowserWindow
// additionalArguments, which become renderer process argv and are visible to
// other local users through process inspection. The sandboxed preload asks for
// it over the same exact-window, exact-origin IPC gate as every native action.
handleTrustedIpc('contextcake:get-api-token', () => service?.token ?? '')
handleTrustedIpc('contextcake:choose-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a ContextCake folder',
    buttonLabel: 'Choose Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

async function createWindow() {
  // The engine runs in its own utilityProcess (service-host.mjs). If it dies
  // after boot the app has no cascade to show and no way to re-point the
  // already-loaded window at a new port, so an unexpected exit is fatal —
  // same clean dialog-and-exit as a failed boot.
  service ??= await startEngineService({ onCrash: handleFatal })
  // Hand the engine its source credentials before the window loads, so a
  // private layer indexes on first paint instead of appearing empty and then
  // filling in.
  await pushGithubTokens()

  const preferences = applyNativeAppearance()
  const uiState = uiStateSnapshot()
  const restored = restoreWindowState(readSettings().mainWindow, screen.getAllDisplays(), screen.getPrimaryDisplay())
  win = new BrowserWindow({
    ...restored.bounds,
    minWidth: 760,
    minHeight: 560,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--cc-version=${app.getVersion()}`,
        `--cc-signed-in=${currentAuthState().signedIn ? '1' : '0'}`,
        `--cc-theme=${preferences.theme}`,
        `--cc-density=${preferences.density}`,
        `--cc-update-check=${preferences.updateCheck ? '1' : '0'}`,
        `--cc-anonymous-metrics=${preferences.anonymousMetrics === null ? '' : preferences.anonymousMetrics ? '1' : '0'}`,
        `--cc-reduced-transparency=${preferences.reducedTransparency ? '1' : '0'}`,
        `--cc-high-contrast=${preferences.highContrast ? '1' : '0'}`,
        `--cc-ui-state=${encodeURIComponent(JSON.stringify(uiState))}`,
        // Whether this build ships accounts at all. Static for the process, so
        // the renderer can drop the Account pane on first paint rather than
        // rendering it and then discovering there is nothing behind it.
        `--cc-accounts=${currentAuthState().available ? '1' : '0'}`,
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
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('maximize', () => scheduleWindowStateSave(win))
  win.on('unmaximize', () => scheduleWindowStateSave(win))
  win.on('close', () => { clearTimeout(windowStateTimer); windowStateTimer = null; saveWindowState(win) })
  win.on('closed', () => { clearTimeout(windowStateTimer); windowStateTimer = null; win = null })
  await win.loadURL(`${service.origin}/console/`)
  if (restored.maximized) win.maximize()
  startManifestSync()
}

/**
 * Worst observed delay of a fixed-interval timer on the MAIN process — a
 * direct read of how blocked the UI thread is. The engine runs in its own
 * utilityProcess, so even while it reads thousands of documents this should
 * stay near zero; before that split, indexing work landed right here.
 */
function measureMainLoopLag(durationMs, intervalMs = 20) {
  return new Promise((resolve) => {
    let worst = 0
    let previous = Date.now()
    const ticker = setInterval(() => {
      const now = Date.now()
      worst = Math.max(worst, now - previous - intervalMs)
      previous = now
    }, intervalMs)
    setTimeout(() => { clearInterval(ticker); resolve(worst) }, durationMs)
  })
}

async function smokeCheck() {
  // CC_SMOKE=1: boot, prove the service answers with the token, exit.
  // Used by CI and agents — no lingering window.
  try {
    // Exercise the wrapper used after a settings pull, not only HTTP reads.
    // It round-trips to the engine process now, so await the acknowledgement.
    await service.reload()
    const authHeaders = { authorization: `Bearer ${service.token}` }
    // The first read starts the engine's background index; measure the main
    // loop while that work is actually running.
    const first = await fetch(`${service.origin}/api/graph`, { headers: authHeaders })
    const graph = await first.json().catch(() => null)
    const lag = await measureMainLoopLag(1200)
    const res = await fetch(`${service.origin}/api/graph`, { headers: authHeaders })
    const unauth = await fetch(`${service.origin}/api/graph`)
    // Guard the app-name/CLI agreement: userData must resolve under a dir named
    // "ContextCake" so `contextcake mcp` finds the manifest the app wrote.
    const userDataName = path.basename(app.getPath('userData'))
    const okName = userDataName === 'ContextCake'
    if (res.ok && unauth.status === 401 && okName) {
      console.log(
        `SMOKE OK ${service.origin} api=200 unauth=401 userData=${userDataName}`
        + ` lag=${lag}ms indexing=${graph?.indexing === true}`,
      )
      shutdownEngine()
      app.exit(0)
    } else {
      console.error(`SMOKE FAIL api=${res.status} unauth=${unauth.status} userData=${userDataName}`)
      shutdownEngine()
      app.exit(1)
    }
  } catch (err) {
    console.error('SMOKE FAIL', err?.message ?? err)
    shutdownEngine()
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
  nativeTheme.on('updated', () => sendToRenderer('preferences:changed', desktopPreferencesSnapshot()))
  await initializeAccounts()
  await createWindow()
  installApplicationMenu()
  initUpdater()
  if (currentAuthState().signedIn) await syncAfterSignIn()
  // Ask before the first anonymous metric — but never before the user has a
  // cascade: a fresh install with zero layers defers the question until the
  // manifest watcher sees its first layer land (or until a later launch that
  // already has one). Installs that arrive with layers — an upgrade, or a
  // skipped wizard revisited — prompt at boot exactly as before. Update checks
  // and metrics remain separate choices, and either can be changed later in
  // Settings or the app menu. Development and smoke builds never show the
  // prompt or report.
  if (app.isPackaged) {
    if (shouldDeferConsentPrompt({ storedPreference: readSettings().anonymousMetrics, manifest: readManifestConfig() })) {
      consentPromptDeferred = true
    } else {
      await ensureAnonymousMetricsPreference()
    }
  }
  installApplicationMenu()
  reportAnonymousFirstLaunch().catch(() => {})
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
  clearTimeout(windowStateTimer)
  if (manifestWatchStarted) fs.unwatchFile(manifestPath())
  authManager?.close()
  shutdownEngine()
})
