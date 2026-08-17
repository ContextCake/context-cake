import { isEngineOrigin } from './navigation.mjs'

export const TRUSTED_WINDOW_ROLES = Object.freeze(['main', 'settings'])

const BOTH_ROLES = Object.freeze(['main', 'settings'])

// Fixed-purpose native capabilities. Keeping the policy beside the registry
// makes omissions reviewable and testable instead of relying on implicit
// defaults spread through main.mjs.
export const TRUSTED_IPC_ROLES = Object.freeze({
  'auth:get-state': BOTH_ROLES,
  'auth:sign-in': BOTH_ROLES,
  'auth:cancel-sign-in': BOTH_ROLES,
  'auth:sign-out': BOTH_ROLES,
  'auth:delete-account': BOTH_ROLES,
  'settings:sync-state': BOTH_ROLES,
  'settings:pull': BOTH_ROLES,
  'integrations:list': BOTH_ROLES,
  'integrations:add-token': BOTH_ROLES,
  'integrations:disconnect': BOTH_ROLES,
  'preferences:get': BOTH_ROLES,
  'preferences:set': BOTH_ROLES,
  'updates:get-status': BOTH_ROLES,
  'updates:check': BOTH_ROLES,
  'updates:install': BOTH_ROLES,
  'ui-state:get': BOTH_ROLES,
  'ui-state:set': BOTH_ROLES,
  'contextcake:get-api-token': BOTH_ROLES,
  // The Connect Agent dialog (main window) and Settings → General both surface
  // the command-line tool; the install itself only ever symlinks the bundled
  // shim (see cli-install.mjs), whichever window asks.
  'contextcake:cli-status': BOTH_ROLES,
  'contextcake:cli-install': BOTH_ROLES,
  'contextcake:choose-folder': Object.freeze(['main']),
  // Only the main window browses files, and the payload is a layer name plus a
  // relative path — never a path the renderer chose (see reveal.mjs).
  'contextcake:reveal-file': Object.freeze(['main']),
  // The app's own config folder — a fixed path with no renderer input at all.
  // Settings is the surface that offers it.
  'contextcake:reveal-config-dir': Object.freeze(['settings']),
  // The engine log folder — same fixed-path doctrine, same surface.
  'contextcake:reveal-logs': Object.freeze(['settings']),
  // Export writes settings.json to a destination chosen in a native save
  // dialog (no renderer path); reset confirms natively before writing. Both
  // are Settings-surface actions.
  'contextcake:settings-export': Object.freeze(['settings']),
  'contextcake:settings-reset': Object.freeze(['settings']),
  // Restarting the engine reloads the main window at a new origin, so only the
  // window that owns the wedge banner may ask for it.
  'contextcake:engine-relaunch': Object.freeze(['main']),
  'windows:open-settings': Object.freeze(['main']),
  'data:reload-requested': Object.freeze(['settings']),
})

export function trustedRolesForChannel(channel) {
  const roles = TRUSTED_IPC_ROLES[channel]
  if (!roles) throw new Error(`No trusted-window policy for IPC channel: ${channel}`)
  return roles
}

/**
 * Exact BrowserWindow/webContents registry for every renderer the app creates.
 * A URL on the right origin is not sufficient: the sender must be the exact,
 * live main frame registered for a role allowed by the channel.
 */
export function createTrustedWindowRegistry(getEngineOrigin) {
  const entries = new Map()

  function register(window, role) {
    if (!TRUSTED_WINDOW_ROLES.includes(role)) throw new Error('Invalid trusted window role.')
    if (!window?.webContents || window.webContents.isDestroyed?.()) throw new Error('Cannot register a destroyed window.')
    const contents = window.webContents
    entries.set(contents.id, { window, webContents: contents, role })
    const remove = () => entries.delete(contents.id)
    contents.once?.('destroyed', remove)
    window.once?.('closed', remove)
    return remove
  }

  function resolve(event, allowedRoles = TRUSTED_WINDOW_ROLES) {
    const sender = event?.sender
    const entry = sender ? entries.get(sender.id) : null
    const origin = getEngineOrigin?.()
    const frame = event?.senderFrame
    const frameUrl = frame?.url || sender?.getURL?.() || ''
    const isMainFrame = Boolean(frame && sender?.mainFrame && frame === sender.mainFrame)
    if (
      !entry
      || entry.webContents !== sender
      || entry.window?.isDestroyed?.()
      || sender?.isDestroyed?.()
      || !isMainFrame
      || !origin
      || !isEngineOrigin(frameUrl, origin)
      || !allowedRoles.includes(entry.role)
    ) throw new Error('Untrusted IPC sender.')
    return entry
  }

  function broadcast(channel, payload, roles = TRUSTED_WINDOW_ROLES) {
    for (const [id, entry] of entries) {
      if (entry.window?.isDestroyed?.() || entry.webContents?.isDestroyed?.()) {
        entries.delete(id)
        continue
      }
      if (roles.includes(entry.role)) entry.webContents.send(channel, payload)
    }
  }

  function windowForRole(role) {
    for (const entry of entries.values()) {
      if (entry.role === role && !entry.window?.isDestroyed?.() && !entry.webContents?.isDestroyed?.()) return entry.window
    }
    return null
  }

  return { register, resolve, broadcast, windowForRole, size: () => entries.size }
}
