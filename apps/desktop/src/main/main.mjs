import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron'
import { startEngineService } from './service-host.mjs'
import { createEngineWatchdog } from './engine-watchdog.mjs'
import { createGithubConnections, verifyGithubToken } from './github-connections.mjs'
import { buildMenu } from './menu.mjs'
import { configDir, enginePaths, manifestPath, settingsPath } from './paths.mjs'
import { resolveRevealTarget } from './reveal.mjs'
import { flushSettings, flushSettingsSync, markSettingsDirty, readSettings, resetSettings, writeLocalSettings, writeSettings } from './settings.mjs'
import { createAuthManager } from './auth.mjs'
import {
  combineManifestSources,
  createSettingsSync,
  overlaySyncShadow,
  selectManifestProfiles,
  selectSyncSettings,
} from './settings-sync.mjs'
import { loadSupabaseConfig } from './supabase-config.mjs'
import { checkForUpdatesFromRenderer, getUpdateStatus, initUpdater, installNow, registerRendererUpdates } from './updater.mjs'
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
 * Bumped by every teardown. An engine forked before the bump belongs to a
 * generation nobody is going to close — see startEngine().
 */
let engineEpoch = 0

/**
 * Stop the engine process and stop treating its exit as a crash. Every path
 * that ends the app — before-quit, a fatal error, the smoke check's app.exit —
 * must go through this, because app.exit() does not fire before-quit.
 *
 * `close()` marks the handle closing before it kills the child, which is what
 * keeps a deliberate teardown (including the watchdog's relaunch) out of the
 * fatal-exit path.
 */
function shutdownEngine() {
  engineEpoch += 1
  engineWatchdog?.stop()
  try { service?.close() } catch { /* already down */ }
  service = null
}

/**
 * Fork the engine and adopt it — but only if nothing tore the engine down
 * while it was booting. Without the epoch check, a quit that arrived during
 * the `await` ran shutdownEngine() against a null handle (a no-op), and the
 * handle assigned afterwards was never closed: `close()` is the only thing
 * that sends the engine the `{type:'close'}` it needs in order to kill the MCP
 * servers it spawned, so the leak was an engine process plus one child per
 * `"source":"mcp"` layer.
 *
 * @returns the live handle, or null when the app is no longer interested.
 */
async function startEngine() {
  const epoch = engineEpoch
  const started = await startEngineService({ onCrash: handleFatal })
  if (engineEpoch !== epoch) {
    try { started.close() } catch { /* already down */ }
    return null
  }
  service = started
  return started
}

let authManager = null
let engineWatchdog = null
let relaunchingEngine = false
let relaunchPromptOpen = false
// Asked once per outage, not once per tick. The banner keeps a Restart Engine
// button on screen, so declining hides a dialog rather than the option.
let relaunchDeclined = false
let settingsSync = null
let pendingDeepLink = null
let settingsPushTimer = null
let manifestWatchStarted = false
let lastAppliedManifest = ''
let installMetricAbortController = null
let consentPromptDeferred = false
let windowStateTimer = null
// Renderer console errors, kept for the UI smoke check. A renderer stuck in an
// error loop emits them faster than anything reads them, so this is a ring:
// the newest RENDERER_ERROR_LIMIT are held and the overflow is counted, never
// accumulated. Unbounded, a single bad render kept every message string alive
// in the main process for the life of the app.
const RENDERER_ERROR_LIMIT = 200
const rendererErrors = []
let rendererErrorsDropped = 0

function recordRendererError(message) {
  rendererErrors.push(String(message ?? 'Unknown renderer error'))
  while (rendererErrors.length > RENDERER_ERROR_LIMIT) {
    rendererErrors.shift()
    rendererErrorsDropped += 1
  }
}

function currentAuthState() {
  return authManager?.getState() ?? { available: false, signedIn: false }
}

function currentSyncState() {
  return settingsSync?.getState() ?? { status: 'idle' }
}

function sendToRenderer(channel, payload) {
  trustedWindows.broadcast(channel, payload)
}

// ---- Engine liveness --------------------------------------------------------
//
// An engine that EXITS is fatal and already handled (onCrash below). An engine
// that is alive and has stopped answering is a different failure, and until now
// nothing looked for it: the window kept its last paint, every fetch hung, and
// the app was indistinguishable from one that had simply gone quiet. The
// watchdog pings the cheapest endpoint the engine has, tells the window when the
// answers stop, and — once it has been unresponsive long enough to call stuck
// rather than busy — lets the user restart it without losing the app.

async function pingEngine(signal) {
  const current = service
  if (!current) throw new Error('the engine is not running')
  const res = await fetch(`${current.origin}/api/status`, {
    headers: { authorization: `Bearer ${current.token}` },
    signal,
  })
  // Drain the body: an undrained response holds its socket, and this runs
  // forever. The status code itself is not the signal — ANY answer means the
  // engine's loop is turning, which is the only thing being measured here.
  const body = await res.text().catch(() => '')
  reportEngineMemory(body)
  return res.status
}

// The watchdog's own ping already fetches /api/status, which carries the
// engine's memory-pressure level (memory-pressure.mjs, surfaced through
// service.mjs). Piggybacking here gives the renderer a live backpressure
// signal — throttle its own polling, show a banner — at zero extra request
// cost. Only the level crosses the bridge, and only on change: this is not a
// second channel worth of traffic, just the one field of a response the
// watchdog needed anyway.
let lastReportedMemoryLevel = null
function reportEngineMemory(rawBody) {
  let level
  try { level = JSON.parse(rawBody)?.memory } catch { return }
  if (typeof level !== 'string' || level === lastReportedMemoryLevel) return
  lastReportedMemoryLevel = level
  trustedWindows.broadcast('engine:memory', { level }, ['main'])
}

function startEngineWatchdog() {
  engineWatchdog ??= createEngineWatchdog({
    ping: pingEngine,
    onState: (state) => {
      // Only the main window carries the shell banner; the settings window has
      // no place to put it.
      trustedWindows.broadcast('engine:status', state, ['main'])
      if (state.healthy) relaunchDeclined = false
      else if (state.canRelaunch && !relaunchDeclined) offerEngineRelaunch()
    },
  })
  engineWatchdog.start()
}

/**
 * Ping now rather than at the next tick. A message-port round trip that went
 * unanswered is evidence about the same process the watchdog is watching, so
 * it converts into the one measurement that can confirm or dismiss it — never
 * into a fabricated miss, which would let a busy port alone raise a banner.
 */
function noteUnackedEngineMessage(kind, reason) {
  console.error(`[contextcake] the engine did not acknowledge ${kind} (${reason})`)
  engineWatchdog?.checkNow()?.catch(() => {})
}

/**
 * Reload the engine's manifest and act on whether it actually happened. The
 * old fire-and-forget call could not tell a re-read from a wedge.
 */
function reloadEngine() {
  const current = service
  if (!current?.reload) return Promise.resolve({ acked: false, reason: 'no-engine' })
  return current.reload().then((result) => {
    if (result?.acked === false) noteUnackedEngineMessage('a manifest reload', result.reason)
    return result
  })
}

async function offerEngineRelaunch() {
  // Smoke and CI must never meet a modal. The banner still reaches the window.
  if (process.env.CC_SMOKE === '1' || !app.isReady()) return
  if (relaunchPromptOpen || relaunchingEngine || !win || win.isDestroyed()) return
  relaunchPromptOpen = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep Waiting', 'Restart Engine'],
      defaultId: 1,
      cancelId: 0,
      title: 'ContextCake Engine Not Responding',
      message: 'The ContextCake engine has stopped responding.',
      detail: 'Restarting it keeps the app open and your sources and settings untouched. '
        + 'The window will reload, so anything you have typed but not saved will be lost.',
    })
    if (response === 1) await relaunchEngine()
    else relaunchDeclined = true
  } catch { /* the window went away mid-prompt */ } finally {
    relaunchPromptOpen = false
  }
}

/**
 * Re-fork the engine and point the windows at the new one.
 *
 * The renderer reload is not avoidable: the engine binds an ephemeral loopback
 * port and mints a fresh bearer per launch, so the loaded document is on an
 * origin that no longer exists. That is the same fact that makes an engine
 * *exit* fatal — but an exit leaves nothing to restart, whereas here the app,
 * its windows and its config are all intact, so the honest move is to rebuild
 * the one part that broke rather than to quit.
 */
async function relaunchEngine() {
  if (relaunchingEngine) return { ok: false, reason: 'already-restarting' }
  relaunchingEngine = true
  try {
    shutdownEngine()
    // A fresh engine's memory level is worth reporting even if it happens to
    // land on the same word the old one last reported — the renderer's state
    // otherwise describes a process that no longer exists.
    lastReportedMemoryLevel = null
    if (!(await startEngine())) return { ok: false, reason: 'shutting-down' }
    await pushGithubTokens()
    const targets = [[win, `${service.origin}/console/`]]
    if (settingsWin) targets.push([settingsWin, `${service.origin}/console/?surface=settings`])
    for (const [window, url] of targets) {
      if (!window || window.isDestroyed()) continue
      await window.loadURL(url)
    }
    startEngineWatchdog()
    // Clear the banner on the new engine's first answer rather than at the next
    // tick — the user just asked for this and is watching.
    engineWatchdog?.checkNow()?.catch(() => {})
    return { ok: true }
  } catch (err) {
    // The engine could not be rebuilt — and the app must survive that, because
    // the prompt above promised it would. Routing this through handleFatal
    // showed BOOT-failure copy ("The local engine failed to start. Please
    // reopen ContextCake.") after a boot that had plainly succeeded, and then
    // exited: the one thing the dialog said would not happen. The window, the
    // manifest, the account session and anything typed into Settings are all
    // still here, so keep them, say what actually failed, and leave the
    // banner's Restart Engine button live for another try.
    console.error(`[contextcake] the engine could not be restarted: ${err?.stack ?? err}`)
    shutdownEngine()
    reportEngineRestartFailure(err)
    return { ok: false, reason: 'restart-failed' }
  } finally {
    relaunchingEngine = false
  }
}

/**
 * Tell the user a restart failed, without ending the app.
 *
 * The banner is re-armed rather than replaced: with no engine, the watchdog's
 * ping rejects immediately, so it goes on reporting an unhealthy engine and
 * re-offers a restart on its own clock. `relaunchDeclined` is reset because
 * the user did not decline this — they asked, and it did not work.
 */
function reportEngineRestartFailure(err) {
  relaunchDeclined = false
  startEngineWatchdog()
  engineWatchdog?.checkNow()?.catch(() => {})
  if (process.env.CC_SMOKE === '1' || !app.isReady()) return
  const options = {
    type: 'error',
    buttons: ['OK'],
    title: 'ContextCake Engine Could Not Restart',
    message: 'The ContextCake engine could not be restarted.',
    detail: 'ContextCake is still open and your sources and settings are untouched, but it '
      + 'cannot read them until the engine is running. Try Restart Engine again from the '
      + 'banner, or quit and reopen ContextCake.\n\n'
      + ((err && err.message) || String(err)),
  }
  const parent = win && !win.isDestroyed() ? win : null
  const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  // A rejected dialog promise on the main process is the fatal handler.
  shown.catch(() => { /* the window went away mid-prompt */ })
}

function desktopPreferencesSnapshot(settings = readSettings()) {
  const theme = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
  const density = ['comfortable', 'compact'].includes(settings.density) ? settings.density : 'comfortable'
  // Reduce transparency follows this Mac's Accessibility setting until the user
  // says otherwise in ContextCake's own Settings; `reducedTransparencyPreference`
  // is what they chose (null = still following), `reducedTransparency` is what
  // the renderer should actually do.
  const chosenTransparency = typeof settings.reducedTransparency === 'boolean' ? settings.reducedTransparency : null
  return {
    theme,
    density,
    updateCheck: settings.updateCheck !== false,
    anonymousMetrics: typeof settings.anonymousMetrics === 'boolean' ? settings.anonymousMetrics : null,
    reducedTransparency: chosenTransparency ?? nativeTheme.prefersReducedTransparency === true,
    reducedTransparencyPreference: chosenTransparency,
    systemReducedTransparency: nativeTheme.prefersReducedTransparency === true,
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
    // write land first or it reads a copy one patch behind and writes it back —
    // and if it could not land at all, do not sync a state this Mac cannot
    // reproduce. The push comes back with the next change once writing works.
    flushSettings().then((ok) => { if (ok) settingsSync.push(settingsSnapshot()) }).catch(() => {})
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
  // mutateManifest lives on the engine handle, which is null while a relaunch
  // is in flight. Dropping the pulled source list is better than a TypeError
  // here — the next push carries it, and `settings:pull` would otherwise
  // reject for a reason that has nothing to do with the pull.
  if (!service) return
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
  reloadEngine()
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

  // Parent the sheet the same way handleEngineCredentialFailure does. Now that
  // closing the last window no longer quits on macOS, this is reachable with no
  // window at all: the manifest watcher calls it when the first layer lands.
  // An unparented showMessageBox does not throw — it runs an app-modal loop
  // that blocks the main process behind a dialog the user may not be looking at.
  const parent = win && !win.isDestroyed() ? win : null
  const promptOptions = {
    type: 'question',
    title: 'Anonymous Usage Metrics',
    message: 'Help improve ContextCake?',
    detail: 'ContextCake can download one tiny file from GitHub to share the app version and a one-time signal when it opens successfully. We use this anonymous information to understand adoption and improve the app. GitHub receives ordinary download request metadata, including the network address used to connect. The request never includes your files, paths, prompts, account details, or a device ID. You can change this anytime in Settings.',
    buttons: ['Share Anonymous Metrics', "Don't Share"],
    defaultId: 1,
    cancelId: 1,
  }
  const { response } = await (parent
    ? dialog.showMessageBox(parent, promptOptions)
    : dialog.showMessageBox(promptOptions))
  const enabled = response === 0
  const { written } = writeLocalSettings({ anonymousMetrics: enabled })
  // A metrics-only preference must never turn a writable-settings problem into
  // a fatal app startup. Without a persisted opt-in, do not report — which is
  // why this one caller waits for its own queued write instead of assuming it.
  if (!(await written).ok) return false
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
    if (!(await flushSettings())) return
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
    const result = await service.sendTokens(connections().injectionMap())
    // An unacknowledged send is not a no-op: the engine is still holding the
    // previous credential map, so a private layer reads anonymously and looks
    // empty. Say so instead of leaving the user to wonder about the repo.
    if (result?.acked === false) noteUnackedEngineMessage('source credentials', result.reason)
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
    // A pull rewrites settings.json from what it finds there. Running one while
    // a local write is still owed would write the pre-change file back.
    if (!(await flushSettings())) {
      throw new Error('ContextCake could not save this Mac\'s settings, so syncing was skipped '
        + 'rather than risk overwriting them. Check that the disk is not full and that '
        + '~/Library/Application Support/ContextCake is writable.')
    }
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

// Renderer-facing update status (Settings → "Check for Updates" / "Update
// Now"), alongside the menu's dialog-driven checkInteractive(). Both drive the
// same autoUpdater singleton; this just also pushes status to any trusted
// window so Settings can render it inline instead of a native dialog.
registerRendererUpdates(sendToRenderer)
handleTrustedIpc('updates:get-status', () => getUpdateStatus())
handleTrustedIpc('updates:check', () => checkForUpdatesFromRenderer())
handleTrustedIpc('updates:install', ({ window }) => installNow(window))

// What the renderer is told when a preference it just set did not reach disk.
// It travels as a rejected `invoke`, which is what every caller in the console
// already handles — and is what the synchronous write used to do by throwing,
// until the write became an async queue that swallowed the failure and
// answered with a snapshot that looked like success.
const SETTINGS_WRITE_FAILED = 'ContextCake could not save that change. It is in effect now '
  + 'but will be lost when the app quits — check that the disk is not full and that '
  + '~/Library/Application Support/ContextCake is writable.'

/** Wait for a set of queued writes and report the first that failed. */
async function settleSettingsWrites(pending) {
  const outcomes = await Promise.all(pending)
  const failure = outcomes.find((outcome) => outcome.ok === false)
  if (!failure) return true
  console.error(`[contextcake] settings could not be written: ${failure.error?.message ?? 'unknown error'}`)
  return false
}

handleTrustedIpc('preferences:get', () => desktopPreferencesSnapshot())
handleTrustedIpc('preferences:set', async (candidate) => {
  const current = readSettings()
  const changed = changedPreferencePatch(current, candidate)
  if (Object.keys(changed).length === 0) return desktopPreferencesSnapshot(current)

  // Device-local preferences never enter account sync state: one is a privacy
  // choice and the other describes this Mac's display, not the user's taste.
  const { anonymousMetrics, reducedTransparency, ...synced } = changed
  let next = current
  const pending = []
  const record = (write) => { next = write.settings; pending.push(write.written) }
  if (Object.keys(synced).length > 0) record(writeSettings(synced))
  if (anonymousMetrics !== undefined) record(writeLocalSettings({ anonymousMetrics }))
  if (reducedTransparency !== undefined) record(writeLocalSettings({ reducedTransparency }))

  // Appearance is applied before the disk answers, deliberately: the choice is
  // already what every readSettings() returns, and a theme switch should not
  // wait on I/O. What waits is everything that leaves this machine.
  const preferences = applyNativeAppearance(next)
  if (Object.hasOwn(changed, 'updateCheck')) initUpdater()
  if (anonymousMetrics !== undefined) installApplicationMenu()

  const persisted = await settleSettingsWrites(pending)
  if (anonymousMetrics !== undefined) {
    // The same rule the first-run prompt follows: never report on a choice
    // that is not on disk. Not persisting is a reason to stay quiet, never a
    // reason to start talking, so a failed write cancels either way.
    if (anonymousMetrics && persisted) reportAnonymousFirstLaunch()
    else cancelAnonymousFirstLaunch()
  }
  // Pushing settings we could not save locally would upload a state this Mac
  // cannot reproduce after a restart.
  if (Object.keys(synced).length > 0 && persisted) scheduleSettingsPush()
  if (!persisted) throw new Error(SETTINGS_WRITE_FAILED)
  return preferences
})
handleTrustedIpc('ui-state:set', async (patch) => {
  const currentSettings = readSettings()
  const result = applyUiStatePatch(currentSettings.uiState, patch)
  if (!result.changed) return result.state
  const { written } = writeLocalSettings({ uiState: result.state })
  if (!(await settleSettingsWrites([written]))) throw new Error(SETTINGS_WRITE_FAILED)
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

// The app's own configuration folder (settings.json, manifest.json). Unlike
// reveal-file above there is no renderer input at all: the path is fixed to
// userData, so the only folder this can ever show is the one the app owns.
handleTrustedIpc('contextcake:reveal-config-dir', () => {
  const dir = configDir()
  if (!fs.existsSync(dir)) return { ok: false, error: 'The configuration folder does not exist yet.' }
  shell.showItemInFolder(dir)
  return { ok: true }
})

// Export a copy of settings.json for a support thread. The destination is
// chosen in a native save dialog here — the renderer supplies nothing. The
// queue is flushed first so the copy is what this process believes, not one
// patch behind; the file holds preferences and window/view state only, never
// credentials (settings.mjs, first paragraph).
handleTrustedIpc('contextcake:settings-export', async ({ window }) => {
  const result = await dialog.showSaveDialog(window, {
    title: 'Export ContextCake Settings',
    defaultPath: 'ContextCake-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    // Flushed AFTER the dialog, not before: the user can sit in a save panel
    // for a minute and change a preference in another window meanwhile, and
    // the copy should be the state at Save, not at Export….
    await flushSettings()
    // `_sync` is stripped, not exported. It is bookkeeping no support thread
    // can use, and it carries the account UUID (`ownerUserId`) plus the last
    // synced blob (`shadow`) — which holds layer names and repo slugs that
    // survive `scrubSettings`. Both are empty in an accounts-disabled build,
    // so this is a leak that would arrive silently on the day accounts ship.
    // The row's own copy promises a file that is safe to attach to a bug
    // report; this is what keeps that true.
    const { _sync: _bookkeeping, ...exported } = readSettings()
    // 0600, matching every other writer of this content (settings.mjs,
    // settings-sync.mjs) — an export to a shared folder must not be the one
    // copy other local accounts can read.
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: err?.message ?? 'The settings could not be exported.' }
  }
})

// Reset local preferences to their defaults. Confirmation is native and lives
// here, beside the destructive act, so no renderer state can skip it. The
// same side effects as preferences:set follow the write: appearance re-applies
// and broadcasts, the updater re-reads its enable flag, and the menu rebuilds.
handleTrustedIpc('contextcake:settings-reset', async ({ window }) => {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Reset ContextCake’s local preferences?',
    detail: 'Appearance, update, and view settings on this Mac return to their defaults. '
      + 'Your sources, knowledge, connected accounts, window position, and privacy '
      + 'choices are not affected.',
    buttons: ['Reset Preferences', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return { ok: false, canceled: true }
  const { written } = resetSettings()
  applyNativeAppearance()
  initUpdater()
  installApplicationMenu()
  if (!(await settleSettingsWrites([written]))) throw new Error(SETTINGS_WRITE_FAILED)
  // Same rule as preferences:set — a reset we could not save locally must not
  // be pushed, and one we did save must be, or a second Mac keeps pulling the
  // pre-reset values until something else happens to write.
  scheduleSettingsPush()
  return { ok: true }
})

// The shell's own recovery action for a wedged engine. It is a restart of the
// engine only — the app, its windows and its config all survive.
handleTrustedIpc('contextcake:engine-relaunch', () => relaunchEngine())

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
    `--cc-reduced-transparency-preference=${preferences.reducedTransparencyPreference === null ? '' : preferences.reducedTransparencyPreference ? '1' : '0'}`,
    `--cc-system-reduced-transparency=${preferences.systemReducedTransparency ? '1' : '0'}`,
    `--cc-high-contrast=${preferences.highContrast ? '1' : '0'}`,
    `--cc-native-vibrancy=${process.platform === 'darwin' && role === 'main' ? '1' : '0'}`,
    `--cc-ui-state=${encodeURIComponent(JSON.stringify(uiState))}`,
    `--cc-accounts=${currentAuthState().available ? '1' : '0'}`,
  ]
}

function protectWindowNavigation(window) {
  window.webContents.on('console-message', (event) => {
    const { level, message } = event
    if (level === 'error' || level === 3) recordRendererError(message)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    // `service` is null for as long as an engine relaunch is in flight, and
    // windows stay live through it. Reading `.origin` off null here threw, and
    // an uncaughtException on the main process IS the fatal handler — a
    // renderer-initiated navigation during a wedge recovery would have taken
    // the whole app down. With no engine there is no origin to trust, so the
    // navigation is refused, which is the correct direction to fail.
    if (isEngineOrigin(url, service?.origin)) return
    event.preventDefault()
    openExternalHttps(url)
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
  // The engine runs in its own utilityProcess (service-host.mjs). An
  // unexpected exit after boot is fatal — same clean dialog-and-exit as a
  // failed boot (specs/contextcake-distribution/design.md).
  //
  // Not because the window cannot be re-pointed: it can, and relaunchEngine()
  // does exactly that for a wedge (proved by `npm run smoke:relaunch`). The
  // distinction is that a wedge is a process the app can still reason about,
  // while an exit the app did not ask for means the engine died of something
  // this process cannot see — and silently re-forking into it would loop.
  if (!service && !(await startEngine())) return
  // Hand the engine its source credentials before the window loads, so a
  // private layer indexes on first paint instead of appearing empty and then
  // filling in.
  await pushGithubTokens()

  const preferences = applyNativeAppearance()
  const uiState = uiStateSnapshot()
  const restored = restoreWindowState(readSettings().mainWindow, screen.getAllDisplays(), screen.getPrimaryDisplay())
  // Bind the handlers below to THIS window rather than to the module-level
  // `win`. They outlive the assignment, and `closed` in particular used to
  // clear `win` no matter which window fired it — so an orphaned window
  // closing left the app believing it had no window while one was still on
  // screen, which silently disables the View menu, geometry saving, the
  // relaunch prompt and `activate`.
  const created = new BrowserWindow({
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
  win = created
  trustedWindows.register(created, 'main')
  protectWindowNavigation(created)

  created.once('ready-to-show', () => {
    if (restored.maximized) created.maximize()
    created.show()
  })
  created.webContents.once('did-finish-load', () => {
    sendToRenderer('auth:session-changed', currentAuthState())
    sendToRenderer('settings:sync-status', currentSyncState())
  })
  created.on('resize', () => scheduleWindowStateSave(created))
  created.on('move', () => scheduleWindowStateSave(created))
  created.on('maximize', () => scheduleWindowStateSave(created))
  created.on('unmaximize', () => scheduleWindowStateSave(created))
  created.on('close', () => {
    clearTimeout(windowStateTimer)
    windowStateTimer = null
    saveWindowState(created)
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })
  created.on('closed', () => {
    if (win !== created) return
    clearTimeout(windowStateTimer)
    windowStateTimer = null
    win = null
  })
  await created.loadURL(`${service.origin}/console/${process.env.CC_SMOKE_UI === '1' ? '?mode=demo' : ''}`)
  startManifestSync()
  startEngineWatchdog()
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

/**
 * Round-trip latency of the engine's cheapest endpoint, sampled while it is
 * busy. Isolation says the engine cannot freeze the WINDOW; this says the
 * engine has not frozen ITSELF — a synchronous stretch in its request path
 * would leave main-loop lag at zero and still make every source operation feel
 * dead. Nothing measured that before, which is why a wedged engine could only
 * ever be inferred.
 *
 * Measured from the main process, so a stalled UI thread inflates it too; that
 * is why the main-loop lag number is reported beside it rather than instead of
 * it. The two together say which side is at fault.
 */
async function measureEngineLatency(durationMs, { gapMs = 20, timeoutMs = 5_000 } = {}) {
  const headers = { authorization: `Bearer ${service.token}` }
  const samples = []
  let failures = 0
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const startedAt = Date.now()
    try {
      const res = await fetch(`${service.origin}/api/status`, { headers, signal: AbortSignal.timeout(timeoutMs) })
      await res.text()
      if (!res.ok) failures += 1
    } catch {
      failures += 1
    }
    samples.push(Date.now() - startedAt)
    await new Promise((resolve) => setTimeout(resolve, gapMs))
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0, probes: samples.length, failures }
}

async function smokeCheck() {
  // CC_SMOKE=1: boot, prove the service answers with the token, exit.
  // Used by CI and agents — no lingering window.
  try {
    // CC_SMOKE_QUIT=quit|close: prove the window's frame survives the exit.
    // Moves the window and then ends the app while the 250ms bounds debounce
    // is still pending — which is exactly what "resize, then ⌘Q" looks like.
    // `quit` is app.quit() with the window open (before-quit fires FIRST);
    // `close` is the red X (before-quit fires last). Driven by
    // test/quit-persistence.test.mjs, which reads the geometry back off disk.
    if (process.env.CC_SMOKE_QUIT) {
      win.setBounds({ x: 140, y: 100, width: 1024, height: 720 })
      // Let the platform settle the frame and deliver `resize` (which arms the
      // debounce) without letting the debounce itself fire.
      await new Promise((resolve) => setTimeout(resolve, 60))
      console.log(`QUIT SMOKE bounds=${JSON.stringify(win.getBounds())} pendingSave=${windowStateTimer !== null}`)
      if (process.env.CC_SMOKE_QUIT === 'close') {
        // Closing the last window no longer ends the app on macOS (see
        // window-all-closed), so the smoke ends it itself — after the close,
        // which preserves the ordering this exercises: close fires, then
        // window-all-closed, then before-quit.
        app.once('window-all-closed', () => app.quit())
        win.close()
      } else app.quit()
      return
    }
    // CC_SMOKE_CLOSE_ALIVE=1: on macOS the red X leaves the app running with
    // no windows, so the Dock icon has something to reactivate. Reports what
    // survived the close. Driven by test/window-lifecycle.test.mjs.
    if (process.env.CC_SMOKE_CLOSE_ALIVE === '1') {
      win.close()
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Reaching this line at all is the survival evidence: had the close
      // ended the app, the process would be gone and nothing would print.
      console.log(`CLOSE SMOKE survived-close windows=${BrowserWindow.getAllWindows().length} platform=${process.platform}`)
      // Prove the Dock-click path really does rebuild a window, not just that
      // the process outlived the close.
      //
      // Twice, deliberately: createWindow() awaits a message-port round trip
      // before it constructs anything, and across that await there are still
      // zero windows — so two clicks during a slow engine both used to pass
      // the guard and build two main windows. The count below is what pins it.
      app.emit('activate')
      app.emit('activate')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      console.log(`CLOSE SMOKE reactivated windows=${BrowserWindow.getAllWindows().length}`)
      app.quit()
      return
    }
    // CC_SMOKE_ENGINE_LIFECYCLE=1: the three ways a relaunch used to go wrong,
    // exercised in the real app because all three are about what Electron and
    // the utility process actually do. Driven by test/engine-lifecycle.test.mjs.
    if (process.env.CC_SMOKE_ENGINE_LIFECYCLE === '1') {
      const failures = []

      // 1. A teardown that arrives DURING the relaunch's boot must not leave a
      //    freshly forked engine adopted behind it. `shutdownEngine()` is what
      //    before-quit calls; before the epoch check it ran against a null
      //    handle and the engine assigned afterwards was never closed — so it
      //    never got the `{type:'close'}` that kills its spawned MCP children.
      const racing = relaunchEngine()
      shutdownEngine()
      const raced = await racing
      if (raced?.ok !== false || raced?.reason !== 'shutting-down') {
        failures.push(`race: relaunch answered ${JSON.stringify(raced)}`)
      }
      if (service !== null) failures.push('race: an engine forked during a teardown was adopted')

      // 2. With no engine, a renderer-initiated navigation must be refused
      //    rather than throw. `will-navigate` read `service.origin` unguarded,
      //    and an uncaughtException on the main process is the fatal handler:
      //    the app would exit here. A plain-http target keeps the refusal from
      //    handing anything to the real browser.
      //
      //    Wait for the guard itself rather than a fixed sleep, and compare
      //    ORIGINS. Sleeping 200ms and diffing the whole URL string failed on
      //    loaded CI runners for a reason that had nothing to do with the
      //    guard: the console is live here with no engine behind it, so every
      //    IPC call it makes is being refused, and an in-page history change on
      //    that retry path moves getURL() without any navigation having been
      //    allowed.
      const originOf = (url) => { try { return new URL(url).origin } catch { return url } }
      const originBefore = originOf(win.webContents.getURL())
      let reachedGuard = false
      const watchNavigation = (event, url) => { if (url.startsWith('http://127.0.0.1:1/')) reachedGuard = true }
      win.webContents.on('will-navigate', watchNavigation)
      await win.webContents.executeJavaScript("location.href = 'http://127.0.0.1:1/blocked'")
      for (let waited = 0; waited < 4000 && !reachedGuard; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      win.webContents.off('will-navigate', watchNavigation)
      if (!reachedGuard) failures.push('navigation guard: the navigation attempt never reached the guard')
      if (originOf(win.webContents.getURL()) !== originBefore) failures.push('navigation guard: the window navigated off the engine origin')

      // 3. A relaunch that FAILS must keep the app — that is exactly what the
      //    relaunch prompt promises. It used to call handleFatal, which shows
      //    boot-failure copy after a successful boot and then exits.
      process.env.CC_FORCE_BOOT_FAIL = '1'
      const failed = await relaunchEngine()
      delete process.env.CC_FORCE_BOOT_FAIL
      if (failed?.ok !== false || failed?.reason !== 'restart-failed') {
        failures.push(`failed restart: relaunch answered ${JSON.stringify(failed)}`)
      }
      if (!win || win.isDestroyed()) failures.push('failed restart: the window did not survive')

      // 4. …and the app is still recoverable afterwards.
      const recovered = await relaunchEngine()
      if (recovered?.ok !== true) failures.push(`recovery: relaunch answered ${JSON.stringify(recovered)}`)
      if (!win.webContents.getURL().startsWith(service?.origin ?? ' ')) {
        failures.push('recovery: the window was not re-pointed at the new engine')
      }

      if (failures.length > 0) {
        console.error(`ENGINE LIFECYCLE FAIL ${failures.join(' | ')}`)
        shutdownEngine()
        flushSettingsSync()
        app.exit(1)
        return
      }
      console.log('ENGINE LIFECYCLE OK teardown-race=closed navigation-guard=refused failed-restart=survived recovery=repointed')
      shutdownEngine()
      flushSettingsSync()
      app.exit(0)
      return
    }
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
      if (rendererErrors.length > 0) {
        const dropped = rendererErrorsDropped > 0 ? ` (${rendererErrorsDropped} earlier errors dropped)` : ''
        throw new Error(`Renderer console errors${dropped}: ${rendererErrors.join(' | ')}`)
      }
      console.log('UI SMOKE OK renderer-console-errors=0')
    }
    // CC_SMOKE_RELAUNCH=1: prove the watchdog's recovery actually recovers.
    //
    // Worth a seam of its own because the doubt is real and load-bearing: the
    // comment at createWindow() says there is no way to re-point a loaded
    // window at a new port, which is the reason an engine *exit* is fatal. If
    // that were true of a deliberate restart too, the relaunch offer would be a
    // button that half-works. It is not true — loadURL re-points it — and this
    // is where that stays true. Everything after this block then runs against
    // the relaunched engine, so the restart is proven end to end rather than
    // just observed to return.
    if (process.env.CC_SMOKE_RELAUNCH === '1') {
      const before = { origin: service.origin, token: service.token }
      const result = await relaunchEngine()
      const loaded = win.webContents.getURL()
      const answered = await fetch(`${service.origin}/api/status`, {
        headers: { authorization: `Bearer ${service.token}` },
      })
      // The old engine must be gone, not merely orphaned and still listening.
      const oldEngine = await fetch(`${before.origin}/api/status`, {
        headers: { authorization: `Bearer ${before.token}` },
        signal: AbortSignal.timeout(2_000),
      }).then((r) => r.status).catch(() => 'unreachable')
      // Trusted IPC re-validates the sender against the CURRENT engine origin;
      // if that getter had gone stale the window would be silently unable to
      // authenticate a single API call after recovering.
      const tokenViaIpc = await win.webContents.executeJavaScript('window.__CC_DESKTOP.getApiToken()')
      const relaunchOk = result.ok
        && service.origin !== before.origin
        && service.token !== before.token
        && loaded.startsWith(service.origin)
        && answered.ok
        && oldEngine === 'unreachable'
        && tokenViaIpc === service.token
      if (!relaunchOk) {
        throw new Error(`Relaunch smoke failed: ${JSON.stringify({
          result, before: before.origin, after: service.origin, loaded,
          answered: answered.status, oldEngine, ipcTokenMatches: tokenViaIpc === service.token,
        })}`)
      }
      console.log(
        `RELAUNCH SMOKE OK ${before.origin} -> ${service.origin}`
        + ' window-repointed=true old-engine=unreachable ipc-token=rotated',
      )
    }

    // Exercise the wrapper used after a settings pull, not only HTTP reads.
    // It round-trips to the engine process now, so await the acknowledgement —
    // and check it, because a resolved promise no longer implies one arrived.
    const reloaded = await service.reload()
    if (reloaded?.acked !== true) {
      throw new Error(`the engine did not acknowledge a manifest reload (${reloaded?.reason ?? 'unknown'})`)
    }
    const authHeaders = { authorization: `Bearer ${service.token}` }
    // The first read starts the engine's background index; measure both loops
    // while that work is actually running — the main process's (is the UI
    // thread free?) and the engine's own (is it still answering?).
    const first = await fetch(`${service.origin}/api/graph`, { headers: authHeaders })
    const graph = await first.json().catch(() => null)
    const [lag, latency] = await Promise.all([measureMainLoopLag(1200), measureEngineLatency(1200)])
    const res = await fetch(`${service.origin}/api/graph`, { headers: authHeaders })
    const unauth = await fetch(`${service.origin}/api/graph`)
    // Guard the app-name/CLI agreement: userData must resolve under a dir named
    // "ContextCake" so `contextcake mcp` finds the manifest the app wrote.
    const userDataName = path.basename(app.getPath('userData'))
    const okName = userDataName === 'ContextCake'
    if (res.ok && unauth.status === 401 && okName) {
      console.log(
        `SMOKE OK ${service.origin} api=200 unauth=401 userData=${userDataName}`
        + ` lag=${lag}ms indexing=${graph?.indexing === true}`
        + ` engineP50=${latency.p50}ms engineP95=${latency.p95}ms engineMax=${latency.max}ms`
        + ` engineProbes=${latency.probes} engineFailures=${latency.failures}`,
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
  // Launching the app again while it is running with no windows — now a real
  // state on macOS — should give you a window, not silently do nothing.
  if (!win) { ensureMainWindow().catch(handleFatal); return }
  if (win.isMinimized()) win.restore()
  win.focus()
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

// Rebuilding the main window has to be serialized, and it has to ask about the
// MAIN window specifically.
//
// createWindow() awaits before it constructs anything — pushGithubTokens() is a
// message-port round trip with a 5s deadline — and across that whole await
// there are still zero windows. A second Dock click during a slow engine
// therefore built a second main window, both registered as 'main'.
//
// Counting all windows was the other half: a lone Settings window (⌘, works
// with no main window) made getAllWindows() non-zero, so the Dock icon stopped
// producing a window at all, and with no File > New Window there was no other
// way back.
let mainWindowPending = null

function ensureMainWindow() {
  if (trustedWindows.windowForRole('main')) return Promise.resolve()
  mainWindowPending ??= createWindow().finally(() => { mainWindowPending = null })
  return mainWindowPending
}

app.on('activate', () => { ensureMainWindow().catch(handleFatal) })

app.on('window-all-closed', () => {
  // On macOS closing the last window is not quitting — the app stays in the
  // Dock and `activate` above builds a new window when its icon is clicked.
  // Quitting here made that handler unreachable: the red button ended the
  // process, so there was never a running app for the Dock icon to reopen.
  // Everywhere else, no windows does mean done.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  clearTimeout(settingsPushTimer)
  settingsPushTimer = null
  clearTimeout(windowStateTimer)
  windowStateTimer = null
  // Electron fires before-quit BEFORE the window's own `close`, so this is the
  // last point at which the frame still exists AND a synchronous flush can
  // still land it. Leaving the save to `close` alone lost every ⌘Q made after
  // a resize: this handler cancelled the pending debounce, flushed an empty
  // queue, and only then did `close` compute the geometry — onto an
  // asynchronous queue the exiting process never drained. The red-X path is
  // the mirror image (close → window-all-closed → quit → before-quit), and the
  // flush below is what lands what `close` queued there.
  saveWindowState(win)
  flushSettingsSync()
  if (manifestWatchStarted) fs.unwatchFile(manifestPath())
  authManager?.close()
  shutdownEngine()
})
