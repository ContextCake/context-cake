// Sandboxed preload: the ONLY bridge between the console renderer and the
// desktop shell. Keep this surface tiny — the renderer is a web app that must
// keep working in browsers where none of this exists.
const { contextBridge, ipcRenderer } = require('electron')

function arg(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}

contextBridge.exposeInMainWorld('__CC_DESKTOP', {
  // Per-launch bearer token the local engine service requires on /api/*. It is
  // fetched through trusted IPC, never renderer argv (visible through `ps`).
  getApiToken: () => ipcRenderer.invoke('contextcake:get-api-token'),
  // App version, for display. Updates are owned by the native updater.
  version: arg('cc-version'),
  // Initial, non-PII snapshot. The live state (including optional email) is
  // delivered through __CC_AUTH so it never appears in process arguments.
  authState: { signedIn: arg('cc-signed-in') === '1', available: arg('cc-accounts') === '1' },
  preferences: {
    initial: {
      theme: ['system', 'light', 'dark'].includes(arg('cc-theme')) ? arg('cc-theme') : 'system',
      density: ['comfortable', 'compact'].includes(arg('cc-density')) ? arg('cc-density') : 'comfortable',
      updateCheck: arg('cc-update-check') !== '0',
      anonymousMetrics: arg('cc-anonymous-metrics') === '' ? null : arg('cc-anonymous-metrics') === '1',
      reducedTransparency: arg('cc-reduced-transparency') === '1',
      highContrast: arg('cc-high-contrast') === '1',
    },
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (patch) => ipcRenderer.invoke('preferences:set', patch),
    onChanged: (cb) => subscribe('preferences:changed', cb),
  },
  chooseFolder: () => ipcRenderer.invoke('contextcake:choose-folder'),
  metrics: {
    getEnabled: () => ipcRenderer.invoke('contextcake:metrics-get'),
    setEnabled: (enabled) => ipcRenderer.invoke('contextcake:metrics-set', enabled),
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
  syncSettings: (settings) => ipcRenderer.invoke('settings:push', settings),
  pullSettings: () => ipcRenderer.invoke('settings:pull'),
  getSyncState: () => ipcRenderer.invoke('settings:sync-state'),
  onSyncStatus: (cb) => subscribe('settings:sync-status', cb),
  onSettingsPulled: (cb) => subscribe('settings:pulled', cb),
  bootstrapTheme: (theme) => ipcRenderer.invoke('settings:bootstrap-theme', theme),
})
