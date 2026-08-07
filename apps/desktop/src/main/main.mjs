import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { createGithubConnections, verifyGithubToken } from './github-connections.mjs'
import { buildMenu } from './menu.mjs'
import { configDir, enginePaths, manifestPath, settingsPath } from './paths.mjs'
import { resolveRevealTarget } from './reveal.mjs'
import { flushSettings, flushSettingsSync, markSettingsDirty, readSettings, writeLocalSettings, writeSettings } from './settings.mjs'
import { createAuthManager } from './auth.mjs'
import {
  combineManifestSources,
  createSettingsSync,
  overlaySyncShadow,
  selectManifestProfiles,
  selectSyncSettings,
} from './settings-sync.mjs'
import { loadSupabaseConfig } from './supabase-config.mjs'
import { initUpdater } from './updater.mjs'
import { isEngineOrigin } from './navigation.mjs'
import { createTrustedWindowRegistry, trustedRolesForChannel } from './trusted-windows.mjs'
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
  // second, misleading failure. Settings writes are queued and asynchronous;
  // app.exit() does not drain that queue, so land it synchronously here too.
  shutdownEngine()
  flushSettingsSync()
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
let settingsWin = null
const trustedWindows = createTrustedWindowRegistry(() => service?.origin)

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
const rendererErrors = []

function currentAuthState() {
  return authManager?.getState() ?? { available: false, signedIn: false }
}

function currentSyncState() {
  return settingsSync?.getState() ?? { status: 'idle' }
}

function sendToRenderer(channel, payload) {
  trustedWindows.broadcast(channel, payload)
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
    // settings-sync reads and rewrites settings.json itself. Let our own queued
    // write land first or it reads a copy one patch behind and writes it back.
    flushSettings().then(() => settingsSync.push(settingsSnapshot())).catch(() => {})
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
    (pane) => openSettingsWindow(pane),
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
  writeLocalSettings({ anonymousMetrics: enabled })
  // A metrics-only preference must never turn a writable-settings problem into
  // a fatal app startup. Without a persisted opt-in, do not report — which is
  // why this one caller waits for the queued write instead of assuming it.
  if (!(await flushSettings())) return false
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
    await flushSettings()
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

function handleTrustedIpc(channel, callback) {
  const roles = trustedRolesForChannel(channel)
  ipcMain.handle(channel, (event, ...args) => {
    const entry = trustedWindows.resolve(event, roles)
    return callback(...args, { event, window: entry.window, role: entry.role })
  })
}

async function handleDeepLink(url) {
  if (!authManager) {
    pendingDeepLink = url
    return
  }
  try {
    await authManager.handleDeepLink(url)
    if (settingsWin && !settingsWin.isDestroyed() && currentAuthState().signedIn) {
      settingsWin.webContents.send('windows:settings-pane', 'account')
      if (settingsWin.isMinimized()) settingsWin.restore()
      settingsWin.show()
      settingsWin.focus()
    }
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
  handle('auth:delete-account', async ({ window }) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Delete Account'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete ContextCake Account',
      message: 'Permanently delete your ContextCake account?',
      detail: 'The cloud account and its synced settings will be deleted. Your local ContextCake files and this Mac\'s local settings will remain. This action cannot be undone.',
    })
    if (response !== 1) return currentAuthState()
    await authManager?.deleteAccount()
    return currentAuthState()
  })
  handle('settings:sync-state', currentSyncState)
  handle('settings:pull', async () => {
    await flushSettings()
    const pulled = await settingsSync?.pull(settingsSnapshot())
    publishPulledSettings(pulled)
    return pulled ? { overwritten: pulled.overwritten, settings: selectSyncSettings(pulled.settings) } : null
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
handleTrustedIpc('contextcake:cli-install', ({ window }) => installCli(window, { showSuccess: false }))
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
// The API token is a credential: never put it in BrowserWindow
// additionalArguments, which become renderer process argv and are visible to
// other local users through process inspection. The sandboxed preload asks for
// it over the same exact-window, exact-origin IPC gate as every native action.
handleTrustedIpc('contextcake:get-api-token', () => service?.token ?? '')
handleTrustedIpc('contextcake:choose-folder', async ({ window }) => {
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose a ContextCake folder',
    buttonLabel: 'Choose Folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// Reveal in Finder. The renderer names a source and a path INSIDE it; the
// absolute path is resolved here, against the manifest on disk, with the
// engine's own containment guard. A path that escapes its source folder is
// refused rather than clamped — see src/main/reveal.mjs.
handleTrustedIpc('contextcake:reveal-file', async ({ layer, rel } = {}) => {
  try {
    const target = await resolveRevealTarget({
      layer,
      rel,
      manifestFile: manifestPath(),
      engineSrc: enginePaths().engineSrc,
    })
    shell.showItemInFolder(target)
    return { ok: true }
  } catch (err) {
    // The reason travels as data rather than as a rejected invoke, so the
    // console can render it verbatim instead of Electron's wrapper text.
    return { ok: false, error: err?.message ?? 'That file could not be revealed.' }
  }
})

handleTrustedIpc('windows:open-settings', (pane) => openSettingsWindow(pane))
handleTrustedIpc('data:reload-requested', () => {
  trustedWindows.broadcast('data:reload-requested', undefined, ['main'])
  return { requested: true }
})

const VALID_SETTINGS_PANES = new Set(['general', 'indexing', 'integrations', 'account', 'privacy'])

function rendererArguments(preferences, uiState, role) {
  return [
    `--cc-window-role=${role}`,
    `--cc-version=${app.getVersion()}`,
    `--cc-signed-in=${currentAuthState().signedIn ? '1' : '0'}`,
    `--cc-theme=${preferences.theme}`,
    `--cc-density=${preferences.density}`,
    `--cc-update-check=${preferences.updateCheck ? '1' : '0'}`,
    `--cc-anonymous-metrics=${preferences.anonymousMetrics === null ? '' : preferences.anonymousMetrics ? '1' : '0'}`,
    `--cc-reduced-transparency=${preferences.reducedTransparency ? '1' : '0'}`,
    `--cc-high-contrast=${preferences.highContrast ? '1' : '0'}`,
    `--cc-native-vibrancy=${process.platform === 'darwin' && role === 'main' ? '1' : '0'}`,
    `--cc-ui-state=${encodeURIComponent(JSON.stringify(uiState))}`,
    `--cc-accounts=${currentAuthState().available ? '1' : '0'}`,
  ]
}

function protectWindowNavigation(window) {
  window.webContents.on('console-message', (event) => {
    const { level, message } = event
    if (level === 'error' || level === 3) rendererErrors.push(String(message ?? 'Unknown renderer error'))
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isEngineOrigin(url, service.origin)) {
      event.preventDefault()
      openExternalHttps(url)
    }
  })
}

async function openSettingsWindow(requestedPane) {
  const pane = VALID_SETTINGS_PANES.has(requestedPane) ? requestedPane : uiStateSnapshot().settingsPane
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('windows:settings-pane', pane)
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return { opened: true, existing: true }
  }
  if (!service) return { opened: false, existing: false }

  const preferences = desktopPreferencesSnapshot()
  const uiState = { ...uiStateSnapshot(), settingsPane: pane }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    maximizable: false,
    fullscreenable: false,
    resizable: true,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: rendererArguments(preferences, uiState, 'settings'),
    },
  })
  trustedWindows.register(settingsWin, 'settings')
  protectWindowNavigation(settingsWin)
  settingsWin.once('ready-to-show', () => {
    settingsWin?.show()
    settingsWin?.focus()
  })
  settingsWin.webContents.once('did-finish-load', () => {
    settingsWin?.webContents.send('auth:session-changed', currentAuthState())
    settingsWin?.webContents.send('settings:sync-status', currentSyncState())
    settingsWin?.webContents.send('windows:settings-pane', pane)
  })
  settingsWin.on('close', () => { Promise.resolve(authManager?.cancelSignIn?.()).catch(() => {}) })
  settingsWin.on('closed', () => { settingsWin = null })
  await settingsWin.loadURL(`${service.origin}/console/?surface=settings`)
  return { opened: true, existing: false }
}

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
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: rendererArguments(preferences, uiState, 'main'),
    },
  })
  trustedWindows.register(win, 'main')
  protectWindowNavigation(win)

  win.once('ready-to-show', () => {
    if (restored.maximized) win.maximize()
    win.show()
  })
  win.webContents.once('did-finish-load', () => {
    sendToRenderer('auth:session-changed', currentAuthState())
    sendToRenderer('settings:sync-status', currentSyncState())
  })
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('maximize', () => scheduleWindowStateSave(win))
  win.on('unmaximize', () => scheduleWindowStateSave(win))
  win.on('close', () => {
    clearTimeout(windowStateTimer)
    windowStateTimer = null
    saveWindowState(win)
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })
  win.on('closed', () => { clearTimeout(windowStateTimer); windowStateTimer = null; win = null })
  await win.loadURL(`${service.origin}/console/${process.env.CC_SMOKE_UI === '1' ? '?mode=demo' : ''}`)
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
    const artifactDir = process.env.CC_SMOKE_ARTIFACT_DIR || ''
    const capture = async (window, name) => {
      if (!artifactDir) return
      fs.mkdirSync(artifactDir, { recursive: true })
      const image = await window.webContents.capturePage()
      fs.writeFileSync(path.join(artifactDir, `${name}.png`), image.toPNG())
    }
    if (process.env.CC_SMOKE_SETTINGS === '1' || process.env.CC_SMOKE_UI === '1') {
      const first = await openSettingsWindow('privacy')
      const second = await openSettingsWindow('privacy')
      const snapshot = await settingsWin?.webContents.executeJavaScript(`({
        href: location.href,
        label: document.querySelector('.cc-settings-screen')?.getAttribute('aria-label'),
        text: document.body.textContent,
      })`)
      const settingsOk = first?.opened && !first?.existing && second?.existing
        && BrowserWindow.getAllWindows().length === 2
        && snapshot?.href?.includes('surface=settings')
        && snapshot?.label === 'ContextCake Settings'
        && snapshot?.text?.includes('Privacy')
      if (!settingsOk) throw new Error(`Settings smoke failed: ${JSON.stringify({ first, second, windows: BrowserWindow.getAllWindows().length, snapshot })}`)
      console.log('SETTINGS SMOKE OK single-instance surface=settings pane=privacy')
      await capture(settingsWin, 'settings-privacy')
      settingsWin.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const restored = await openSettingsWindow()
      const restoredPane = await settingsWin?.webContents.executeJavaScript(
        `document.querySelector('.cc-settings-nav button[aria-current="page"]')?.textContent`,
      )
      if (!restored?.opened || restored?.existing || restoredPane?.trim() !== 'Privacy') {
        throw new Error(`Settings pane restoration failed: ${JSON.stringify({ restored, restoredPane })}`)
      }
      settingsWin.close()
    }
    if (process.env.CC_SMOKE_UI === '1') {
      const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
      const inspect = async (width, height, hash, expression) => {
        win.setBounds({ x: 80, y: 80, width, height })
        await win.webContents.executeJavaScript(`location.hash=${JSON.stringify(hash)}`)
        await pause()
        const result = await win.webContents.executeJavaScript(expression)
        if (!result?.ok) throw new Error(`UI smoke failed at ${width}x${height} ${hash}: ${JSON.stringify(result)}`)
        // Capture settled geometry rather than an in-flight 150 ms sheet
        // transition; the assertions above intentionally inspect immediately.
        await pause(200)
        await capture(win, `${hash.slice(2)}-${width}x${height}`)
        console.log(`UI SMOKE OK ${width}x${height} ${hash}`)
      }
      await inspect(760, 560, '#/overview', `(() => {
        const sidebar = document.querySelector('.cc-sidebar');
        return { ok: document.body.scrollWidth <= document.body.clientWidth + 1
          && getComputedStyle(sidebar).position === 'fixed'
          && document.querySelectorAll('.cc-nav-button').length === 5,
          body: [document.body.scrollWidth, document.body.clientWidth], sidebar: getComputedStyle(sidebar).position };
      })()`)
      await inspect(900, 640, '#/sources', `(async () => {
        const option = document.querySelector('.cc-source-navigator button[role="option"]'); option?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const detail = document.querySelector('.cc-source-detail');
        const before = Boolean(detail?.hasAttribute('data-open')) && getComputedStyle(detail).position === 'absolute';
        dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const main = document.querySelector('.cc-main');
        const optionRect = option?.getBoundingClientRect();
        const mainRect = main?.getBoundingClientRect();
        return { ok: before && !detail?.hasAttribute('data-open')
          && option?.innerText.includes('personal')
          && (main?.scrollLeft ?? -1) === 0
          && (optionRect?.left ?? -1) >= (mainRect?.left ?? 0)
          && getComputedStyle(document.querySelector('.cc-sidebar-resizer')).display !== 'none'
          && document.body.scrollWidth <= document.body.clientWidth + 1,
          before, text: option?.innerText, mainScrollLeft: main?.scrollLeft,
          optionLeft: optionRect?.left, mainLeft: mainRect?.left,
          position: detail && getComputedStyle(detail).position };
      })()`)
      await inspect(1360, 860, '#/overview', `(async () => {
        const headings = [...document.querySelectorAll('.cc-workspace-section h2')].map((node) => node.textContent);
        document.querySelector('.cc-toolbar-ask')?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const ask = document.querySelector('[aria-label="Ask ContextCake"]');
        const ok = headings.join('|').includes('Needs Attention') && headings.includes('Cascade summary')
          && headings.includes('Source health') && ask?.getAttribute('role') === 'complementary'
          && !ask?.hasAttribute('aria-modal') && document.body.scrollWidth <= document.body.clientWidth + 1;
        document.querySelector('[aria-label="Close chat"]')?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ok, headings, askRole: ask?.getAttribute('role') };
      })()`)
      await inspect(1600, 1000, '#/canvas', `(async () => {
        [...document.querySelectorAll('.cc-canvas-dots button')].find((button) => button.querySelector('code'))?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const inspector = document.querySelector('aside[aria-label$="concept detail"]');
        return { ok: inspector?.getAttribute('role') === 'complementary'
          && !inspector?.hasAttribute('aria-modal')
          && document.body.scrollWidth <= document.body.clientWidth + 1,
          role: inspector?.getAttribute('role'), canvasWidth: document.querySelector('.cc-canvas-dots')?.clientWidth,
          innerWidth, shellWidth: document.querySelector('.cc-main-canvas')?.clientWidth };
      })()`)
      if (artifactDir) {
        await inspect(760, 560, '#/conflicts', `(async () => {
          document.querySelector('[role="option"]')?.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const detail = document.querySelector('[aria-label$="conflict detail"]');
          return { ok: detail?.getAttribute('role') === 'dialog' && detail?.getAttribute('aria-modal') === 'true'
            && document.body.scrollWidth <= document.body.clientWidth + 1 };
        })()`)
        await win.setBounds({ x: 80, y: 80, width: 1360, height: 860 })
        await win.webContents.executeJavaScript(`location.hash='#/concepts'; document.documentElement.dataset.density='compact'`)
        await pause(200)
        await capture(win, 'knowledge-compact-1360x860')
        await win.webContents.executeJavaScript(`location.hash='#/overview'; document.documentElement.dataset.theme='dark'; document.documentElement.dataset.density='compact'`)
        await pause()
        await capture(win, 'home-dark-compact-1360x860')
        await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='light'; document.documentElement.dataset.density='comfortable'; dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`)
        await pause(220)
        await capture(win, 'command-palette-1360x860')
        await pause(100)
        await openSettingsWindow('general')
        await pause(200)
        await capture(settingsWin, 'settings-general')
        settingsWin?.close()
      }
      if (rendererErrors.length > 0) throw new Error(`Renderer console errors: ${rendererErrors.join(' | ')}`)
      console.log('UI SMOKE OK renderer-console-errors=0')
    }
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
      flushSettingsSync()
      app.exit(0)
    } else {
      console.error(`SMOKE FAIL api=${res.status} unauth=${unauth.status} userData=${userDataName}`)
      shutdownEngine()
      flushSettingsSync()
      app.exit(1)
    }
  } catch (err) {
    console.error('SMOKE FAIL', err?.message ?? err)
    shutdownEngine()
    flushSettingsSync()
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
  // Settings. Development and smoke builds never show the
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
  flushSettingsSync()
  if (manifestWatchStarted) fs.unwatchFile(manifestPath())
  authManager?.close()
  shutdownEngine()
})
