// Sandboxed preload: the ONLY bridge between the console renderer and the
// desktop shell. Keep this surface tiny — the renderer is a web app that must
// keep working in browsers where none of this exists.
const { contextBridge, ipcRenderer } = require('electron')

function arg(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}

function jsonArg(name, fallback) {
  try { return JSON.parse(decodeURIComponent(arg(name))) }
  catch { return fallback }
}

contextBridge.exposeInMainWorld('__CC_DESKTOP', {
  windowRole: arg('cc-window-role') === 'settings' ? 'settings' : 'main',
  // Per-launch bearer token the local engine service requires on /api/*. It is
  // fetched through trusted IPC, never renderer argv (visible through `ps`).
  getApiToken: () => ipcRenderer.invoke('contextcake:get-api-token'),
  // App version, for display.
  version: arg('cc-version'),
  // Update status/actions, backed by the native autoUpdater (see
  // src/main/updater.mjs). Settings polls getStatus() on open and subscribes
  // to onStatus() for live progress; the menu's "Check for Updates…" dialog
  // flow drives the same underlying check independently.
  updates: {
    getStatus: () => ipcRenderer.invoke('updates:get-status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (cb) => subscribe('updates:status', cb),
  },
  // Initial, non-PII snapshot. The live state (including optional email) is
  // delivered through __CC_AUTH so it never appears in process arguments.
  authState: { signedIn: arg('cc-signed-in') === '1', available: arg('cc-accounts') === '1' },
  nativeVibrancy: arg('cc-native-vibrancy') === '1',
  preferences: {
    initial: {
      theme: ['system', 'light', 'dark'].includes(arg('cc-theme')) ? arg('cc-theme') : 'system',
      density: ['comfortable', 'compact'].includes(arg('cc-density')) ? arg('cc-density') : 'comfortable',
      updateCheck: arg('cc-update-check') !== '0',
      anonymousMetrics: arg('cc-anonymous-metrics') === '' ? null : arg('cc-anonymous-metrics') === '1',
      reducedTransparency: arg('cc-reduced-transparency') === '1',
      // '' = still following this Mac's Accessibility setting.
      reducedTransparencyPreference: arg('cc-reduced-transparency-preference') === '' ? null : arg('cc-reduced-transparency-preference') === '1',
      systemReducedTransparency: arg('cc-system-reduced-transparency') === '1',
      highContrast: arg('cc-high-contrast') === '1',
    },
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (patch) => ipcRenderer.invoke('preferences:set', patch),
    onChanged: (cb) => subscribe('preferences:changed', cb),
  },
  uiState: {
    initial: jsonArg('cc-ui-state', {
      sidebar: { collapsed: false, width: 232 }, lastView: 'overview',
      knowledgeView: 'concepts', reviewView: 'triage', settingsPane: 'general',
    }),
    set: (patch) => ipcRenderer.invoke('ui-state:set', patch),
  },
  commands: {
    onInvoke: (cb) => subscribe('commands:invoke', cb),
  },
  windows: {
    openSettings: (pane) => ipcRenderer.invoke('windows:open-settings', pane),
    onSettingsPane: (cb) => subscribe('windows:settings-pane', cb),
  },
  data: {
    requestReload: () => ipcRenderer.invoke('data:reload-requested'),
    onReloadRequested: (cb) => subscribe('data:reload-requested', cb),
  },
  // Engine liveness. The main process watches the engine's HTTP loop, because
  // an engine that is alive but no longer answering is invisible from in here —
  // requests just never come back. `relaunch` restarts the engine and reloads
  // this window at its new origin; the app, its windows and its config survive.
  engine: {
    onStatus: (cb) => subscribe('engine:status', cb),
    // Backpressure from the engine's own memory-pressure watermark
    // (packages/core/src/memory-pressure.mjs), piggybacked on the same
    // /api/status ping the watchdog above already makes every 10s.
    onMemory: (cb) => subscribe('engine:memory', cb),
    relaunch: () => ipcRenderer.invoke('contextcake:engine-relaunch'),
  },
  chooseFolder: () => ipcRenderer.invoke('contextcake:choose-folder'),
  // Show a file in Finder. Deliberately a source name plus a path INSIDE that
  // source — this bridge cannot carry an absolute path, so the main process is
  // the only thing that ever decides where on disk Finder is pointed.
  revealFile: (layer, rel) => ipcRenderer.invoke('contextcake:reveal-file', { layer: String(layer ?? ''), rel: String(rel ?? '') }),
  // Show the app's own configuration folder in Finder. The path is fixed on
  // the main-process side; no arguments cross this bridge.
  revealConfigDir: () => ipcRenderer.invoke('contextcake:reveal-config-dir'),
  // Show the engine log in Finder — same fixed-path doctrine.
  revealLogs: () => ipcRenderer.invoke('contextcake:reveal-logs'),
  settingsFile: {
    export: () => ipcRenderer.invoke('contextcake:settings-export'),
    reset: () => ipcRenderer.invoke('contextcake:settings-reset'),
  },
  cli: {
    getStatus: () => ipcRenderer.invoke('contextcake:cli-status'),
    install: () => ipcRenderer.invoke('contextcake:cli-install'),
  },
})

// Source credentials. Separate from __CC_AUTH because it is a separate thing:
// connecting GitHub needs no ContextCake account, and this surface exists even
// in builds that ship none. Only a token going IN ever crosses this bridge —
// list() answers with metadata, never a secret.
contextBridge.exposeInMainWorld('__CC_INTEGRATIONS', {
  list: () => ipcRenderer.invoke('integrations:list'),
  addToken: (token, host) => ipcRenderer.invoke('integrations:add-token', { token, host }),
  disconnect: (alias) => ipcRenderer.invoke('integrations:disconnect', alias),
})

function subscribe(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError('IPC listener must be a function')
  const listener = (_event, value) => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('__CC_AUTH', {
  getState: () => ipcRenderer.invoke('auth:get-state'),
  signIn: (provider) => ipcRenderer.invoke('auth:sign-in', provider),
  cancelSignIn: () => ipcRenderer.invoke('auth:cancel-sign-in'),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  deleteAccount: () => ipcRenderer.invoke('auth:delete-account'),
  onSessionChanged: (cb) => subscribe('auth:session-changed', cb),
  onError: (cb) => subscribe('auth:error', cb),
  pullSettings: () => ipcRenderer.invoke('settings:pull'),
  getSyncState: () => ipcRenderer.invoke('settings:sync-state'),
  onSyncStatus: (cb) => subscribe('settings:sync-status', cb),
})
