// Sandboxed preload: the ONLY bridge between the console renderer and the
// desktop shell. Keep this surface tiny — the renderer is a web app that must
// keep working in browsers where none of this exists.
const { contextBridge } = require('electron')

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
})
