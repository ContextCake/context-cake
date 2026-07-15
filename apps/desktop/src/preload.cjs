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
  // Per-launch bearer token the local engine service requires on /api/*.
  token: arg('cc-token'),
  // App version, for display. Updates are owned by the native updater.
  version: arg('cc-version'),
  // Initial, non-PII snapshot. The live state (including optional email) is
  // delivered through __CC_AUTH so it never appears in process arguments.
  authState: { signedIn: arg('cc-signed-in') === '1' },
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
