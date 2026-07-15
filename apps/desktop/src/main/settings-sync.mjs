import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const SYNC_FIELDS = ['theme', 'updateCheck', 'activeProfile', 'profiles', 'sources']
const SCRUBBED = new Set(['execution', 'path', 'secret'])
const SECRET_KEY = /(?:^|_)(?:password|passwd|secret|token|api_?key|authorization|cookie|credential)(?:$|_)/i
const CONTEXT_KEY = /^(?:content|contents|body|document|documents|knowledge|markdown|payload|raw|resolved|sections|text)$/i
const CREDENTIAL_VALUE = /(?:^Bearer\s+|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/
const SECRET_ASSIGNMENT = /(?:^|[\s?&#:_'"-])(?:access[_-]?token|token|api[_-]?key|client[_-]?secret|private[_-]?key|secret|password|credential|authorization|signature|sig)\s*(?:=|:)/i
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SYNC_JSON = 1_000_000
const MAX_DECODE_PASSES = 8
const SOURCE_KEYS = new Set([
  'args', 'cache', 'command', 'credential', 'kind', 'keychain', 'level', 'name',
  'origin', 'path', 'ref', 'repo', 'source', 'subdir', 'tokenEnv',
])
const CACHE_KEYS = new Set(['dir', 'ttlSeconds'])
const PROFILE_KEYS = new Set(['active', 'id', 'label', 'name', 'preferences', 'sources'])
const MANIFEST_PROFILE_KEYS = new Set(['label', 'layers', 'preferences'])
const PROFILE_PREFERENCE_KEYS = new Set(['theme'])

function scrubMarker(kind) {
  return { __scrubbed: kind }
}

function isMarker(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && SCRUBBED.has(value.__scrubbed)
}

function normalizedKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_')
}

function isSecretKey(key) {
  return SECRET_KEY.test(normalizedKey(key))
}

function assertAllowedKey(key) {
  if (FORBIDDEN_KEYS.has(key)) throw new Error('Settings sync rejected an unsafe object key.')
  if (containsAbsolutePath(key)) throw new Error('Settings sync rejected an absolute path in an object key.')
}

function isAbsolutePath(value) {
  return /^file:\/\//i.test(value)
    || /^~[^/\\]*[/\\]/.test(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
}

function decodeUrlComponent(value) {
  let decoded = value
  for (let attempt = 0; attempt < MAX_DECODE_PASSES; attempt += 1) {
    const hasEncodedOctet = /%[0-9A-Fa-f]{2}/.test(decoded)
    if (!hasEncodedOctet) return decoded
    if (/%(?![0-9A-Fa-f]{2})/.test(decoded)) {
      throw new Error('Settings sync rejected a malformed encoded value.')
    }
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      throw new Error('Settings sync rejected a malformed encoded value.')
    }
  }
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) throw new Error('Settings sync rejected an excessively encoded value.')
  return decoded
}

function containsAbsolutePath(value) {
  if (isAbsolutePath(value)) return true
  const decoded = decodeUrlComponent(value)
  if (decoded !== value && containsAbsolutePath(decoded)) return true
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      for (const candidate of [...url.searchParams.values(), url.hash.slice(1)]) {
        if (candidate && containsAbsolutePath(decodeUrlComponent(candidate))) return true
      }
      return false
    }
  } catch { /* not a standalone network URL */ }
  if (/file:\/\//i.test(value) || /(?:^|[^A-Za-z0-9])~[^/\\\s]*[/\\]/.test(value)) return true
  if (/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(value)) return true
  const withoutNetworkUrls = value.replace(/https?:\/\/[^\s"'<>]+/gi, '')
  return withoutNetworkUrls
    .split(/[\s=,;:()[\]{}]+/)
    .map((part) => part.replace(/^["']|["']$/g, ''))
    .some((part) => isAbsolutePath(part))
}

function containsUrlCredential(value) {
  const decoded = decodeUrlComponent(value)
  const variants = decoded === value ? [value] : [value, decoded]
  const candidates = variants.flatMap((variant) => [variant, ...(variant.match(/https?:\/\/[^\s"'<>]+/gi) ?? [])])
  for (const candidate of candidates) {
    let url
    try { url = new URL(candidate) } catch { continue }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (url.username || url.password) return true
    for (const key of url.searchParams.keys()) {
      const normalized = normalizedKey(key).toLowerCase()
      if (isSecretKey(key) || /^(?:auth|token|signature|sig)$/.test(normalized)) return true
    }
    if (SECRET_ASSIGNMENT.test(url.hash)) return true
  }
  return false
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  for (const key of Object.keys(value)) {
    assertAllowedKey(key)
    if (!allowed.has(key)) throw new Error(`Settings sync rejected an unsupported ${label} field.`)
  }
}

function assertSettingsShape(settings) {
  if (settings.theme !== undefined && settings.theme !== 'light' && settings.theme !== 'dark') {
    throw new Error('Settings sync rejected an invalid theme.')
  }
  if (settings.updateCheck !== undefined && typeof settings.updateCheck !== 'boolean') {
    throw new Error('Settings sync rejected an invalid update preference.')
  }
  if (settings.activeProfile !== undefined && typeof settings.activeProfile !== 'string') {
    throw new Error('Settings sync rejected an invalid active profile.')
  }
  const assertSources = (sources) => {
    if (!Array.isArray(sources)) throw new Error('Settings sync rejected invalid source definitions.')
    for (const source of sources) {
      assertOnlyKeys(source, SOURCE_KEYS, 'source')
      if (source.cache !== undefined) assertOnlyKeys(source.cache, CACHE_KEYS, 'source cache')
    }
  }
  if (settings.sources !== undefined) assertSources(settings.sources)
  if (settings.profiles !== undefined) {
    if (Array.isArray(settings.profiles)) {
      for (const profile of settings.profiles) {
        assertOnlyKeys(profile, PROFILE_KEYS, 'profile')
        if (profile.preferences !== undefined) assertOnlyKeys(profile.preferences, PROFILE_PREFERENCE_KEYS, 'profile preference')
        if (profile.sources !== undefined && (!Array.isArray(profile.sources) || profile.sources.some((item) => typeof item !== 'string'))) {
          throw new Error('Settings sync rejected invalid profile source references.')
        }
      }
    } else {
      if (!settings.profiles || typeof settings.profiles !== 'object') {
        throw new Error('Settings sync rejected invalid profile definitions.')
      }
      for (const [name, profile] of Object.entries(settings.profiles)) {
        assertAllowedKey(name)
        assertOnlyKeys(profile, MANIFEST_PROFILE_KEYS, 'manifest profile')
        if (profile.preferences !== undefined) assertOnlyKeys(profile.preferences, PROFILE_PREFERENCE_KEYS, 'profile preference')
        assertSources(profile.layers)
      }
    }
  }
}

/** Scrub machine paths and indirect secret references at every nesting level. */
export function scrubSettings(value, key = '') {
  const normalized = key.toLowerCase()
  if (normalized === 'command' || normalized === 'args') return scrubMarker('execution')
  if (normalized === 'path' || normalized === 'dir') return scrubMarker('path')
  if (typeof value === 'string') {
    if (normalized === 'tokenenv' || value.toLowerCase().startsWith('keychain:')) {
      return scrubMarker('secret')
    }
    if (containsAbsolutePath(value)) return scrubMarker('path')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => scrubSettings(entry, key))
  if (!value || typeof value !== 'object') return value
  if (isMarker(value)) return value

  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    out[childKey] = scrubSettings(childValue, childKey)
  }
  return out
}

/** Only approved settings metadata can enter the payload at all. */
export function selectSyncSettings(settings) {
  const selected = {}
  for (const field of SYNC_FIELDS) {
    if (settings && Object.hasOwn(settings, field) && settings[field] !== undefined) selected[field] = settings[field]
  }
  return selected
}

function dirtyTombstone(field) {
  if (field === 'profiles') return {}
  if (field === 'sources') return []
  return undefined
}

/** Keep scrubbed remote metadata available while overlaying local values. */
function overlayLocalValue(remote, local) {
  if (local === undefined) return remote
  if (Array.isArray(local)) {
    const remoteArray = Array.isArray(remote) ? remote : []
    const used = new Set()
    const combined = remoteArray.map((entry, index) => {
      const identity = entry && typeof entry === 'object' && (entry.name ?? entry.id)
      const localIndex = identity
        ? local.findIndex((candidate) => candidate && typeof candidate === 'object' && (candidate.name ?? candidate.id) === identity)
        : index < local.length ? index : -1
      if (localIndex < 0) return entry
      used.add(localIndex)
      return overlayLocalValue(entry, local[localIndex])
    })
    for (let index = 0; index < local.length; index += 1) {
      if (!used.has(index)) combined.push(local[index])
    }
    return combined
  }
  if (!local || typeof local !== 'object') return local
  if (isMarker(local)) return local
  const remoteObject = remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : {}
  const out = { ...remoteObject }
  for (const [key, value] of Object.entries(local)) {
    assertAllowedKey(key)
    out[key] = overlayLocalValue(remoteObject[key], value)
  }
  return out
}

export function overlaySyncShadow(shadow, current, dirtyFields = []) {
  const ownerUserId = current?._sync?.ownerUserId
  const currentUserId = current?._sync?.currentUserId
  if (currentUserId && ownerUserId !== currentUserId) {
    return selectSyncSettings(current)
  }
  const combined = overlayLocalValue(selectSyncSettings(shadow), selectSyncSettings(current))
  for (const field of dirtyFields) {
    if (!SYNC_FIELDS.includes(field)) continue
    if (Object.hasOwn(current, field)) combined[field] = current[field]
    else {
      const tombstone = dirtyTombstone(field)
      if (tombstone === undefined) delete combined[field]
      else combined[field] = tombstone
    }
  }
  return combined
}

/** Combine locally runnable layers with synced metadata that still needs setup. */
export function combineManifestSources(
  layers = [],
  pendingSources = [],
  pendingOwnerUserId = null,
  currentUserId = null,
) {
  const ownedPendingSources = currentUserId && pendingOwnerUserId !== currentUserId
    ? []
    : pendingSources
  return overlayLocalValue(
    Array.isArray(ownedPendingSources) ? ownedPendingSources : [],
    Array.isArray(layers) ? layers : [],
  )
}

/** Include remotely derived profiles only for the account that pulled them. */
export function selectManifestProfiles(
  profiles,
  profilesOwnerUserId = null,
  currentUserId = null,
) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return undefined
  if (currentUserId && profilesOwnerUserId && profilesOwnerUserId !== currentUserId) return undefined
  return profiles
}

/** Reject anything suspicious that survived deterministic scrubbing. */
export function assertSafeSyncPayload(value, key = '') {
  if (isMarker(value)) return
  if (isSecretKey(key)) throw new Error('Settings sync rejected a possible credential field.')
  if (CONTEXT_KEY.test(key)) throw new Error('Settings sync rejected context content.')
  if (typeof value === 'string') {
    const gitSshUrl = /^git@[\w.-]+:/.test(value)
    const decoded = decodeUrlComponent(value)
    if (CREDENTIAL_VALUE.test(value) || CREDENTIAL_VALUE.test(decoded)
      || SECRET_ASSIGNMENT.test(value) || SECRET_ASSIGNMENT.test(decoded)
      || containsUrlCredential(value) || (!gitSshUrl && (EMAIL_VALUE.test(value) || EMAIL_VALUE.test(decoded)))) {
      throw new Error('Settings sync rejected a possible credential, personal identifier, or context value.')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeSyncPayload(entry, key)
    return
  }
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, '__scrubbed')) {
    throw new Error('Settings sync rejected a malformed scrub marker.')
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    if (CONTEXT_KEY.test(childKey)) {
      throw new Error('Settings sync rejected context content.')
    }
    assertSafeSyncPayload(childValue, childKey)
  }
}

/** Validate renderer-provided local metadata before writing any plaintext file. */
export function assertSafeLocalSettings(value, key = '') {
  if (typeof value === 'string') {
    if (key.toLowerCase() === 'tokenenv' && ENV_NAME.test(value)) return
    if (value.toLowerCase().startsWith('keychain:')) return
    const gitSshUrl = /^git@[\w.-]+:/.test(value)
    const decoded = decodeUrlComponent(value)
    if (isSecretKey(key) || CONTEXT_KEY.test(key)
      || CREDENTIAL_VALUE.test(value) || CREDENTIAL_VALUE.test(decoded)
      || SECRET_ASSIGNMENT.test(value) || SECRET_ASSIGNMENT.test(decoded)
      || containsUrlCredential(value) || (!gitSshUrl && (EMAIL_VALUE.test(value) || EMAIL_VALUE.test(decoded)))) {
      throw new Error('Local settings rejected a possible plaintext credential, personal identifier, or context value.')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeLocalSettings(entry, key)
    return
  }
  if (!value || typeof value !== 'object') return
  if (isSecretKey(key) || CONTEXT_KEY.test(key)) {
    throw new Error('Local settings rejected a possible plaintext credential or context field.')
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    assertSafeLocalSettings(childValue, childKey)
  }
}

export function prepareSyncPayload(settings) {
  const selected = selectSyncSettings(settings)
  assertSettingsShape(selected)
  const payload = scrubSettings(selected)
  assertSafeSyncPayload(payload)
  if (JSON.stringify(payload).length > MAX_SYNC_JSON) throw new Error('Settings sync payload is too large.')
  return payload
}

function mergeRemoteValue(local, remote) {
  if (isMarker(remote)) return local
  if (Array.isArray(remote)) {
    const localArray = Array.isArray(local) ? local : []
    return remote.map((entry, index) => {
      const identity = entry && typeof entry === 'object' && (entry.name ?? entry.id)
      const localEntry = identity
        ? localArray.find((candidate) => candidate && typeof candidate === 'object' && (candidate.name ?? candidate.id) === identity)
        : localArray[index]
      return mergeRemoteValue(localEntry, entry)
    })
  }
  if (!remote || typeof remote !== 'object') return remote

  // Remote objects are complete snapshots. Missing nested keys represent
  // deletions; scrub markers explicitly preserve machine-local values.
  const out = {}
  const localObject = local && typeof local === 'object' && !Array.isArray(local) ? local : {}
  for (const [key, value] of Object.entries(remote)) {
    assertAllowedKey(key)
    const merged = mergeRemoteValue(localObject[key], value)
    if (merged !== undefined) out[key] = merged
  }
  return out
}

/** Remote metadata wins, except scrubbed machine-local values stay local. */
export function mergeSyncedSettings(local, remote) {
  const out = local && typeof local === 'object' && !Array.isArray(local) ? { ...local } : {}
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return mergeRemoteValue(local, remote)
  for (const [key, value] of Object.entries(remote)) {
    assertAllowedKey(key)
    const merged = mergeRemoteValue(out[key], value)
    if (merged === undefined) delete out[key]
    else out[key] = merged
  }
  return out
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const { sources: _sources, profiles: _profiles, ...diskValue } = value
  fs.writeFileSync(temporary, `${JSON.stringify(diskValue, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function createSettingsSync({
  authManager,
  supabaseClient,
  localSettingsPath,
  getCurrentSettings,
  operationTimeoutMs = 15_000,
}) {
  const events = new EventEmitter()
  let state = { status: 'idle' }
  let operations = Promise.resolve()
  let networkTail = Promise.resolve()

  const setState = (next) => {
    state = next
    events.emit('status-changed', state)
  }

  async function requireSession() {
    const session = await authManager.getSession()
    if (!session?.user?.id) throw new Error('Sign in to sync settings.')
    return session
  }

  function enqueue(operation) {
    const start = () => networkTail.then(operation)
    const result = operations.then(start, start)
    operations = result.catch(() => {})
    return result
  }

  function withTimeout(operation) {
    const controller = new AbortController()
    const abortable = typeof operation?.abortSignal === 'function'
      ? operation.abortSignal(controller.signal)
      : operation
    const settled = Promise.resolve(abortable)
    networkTail = settled.catch(() => {})
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Settings sync timed out.'))
      }, operationTimeoutMs)
      settled.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  async function pushNow(settings) {
    setState({ status: 'syncing' })
    try {
      const session = await requireSession()
      const dirtyFields = settings?._sync?.dirtyFields ?? []
      const snapshot = overlaySyncShadow(settings?._sync?.shadow, {
        ...settings,
        _sync: { ...(settings?._sync ?? {}), currentUserId: session.user.id },
      }, dirtyFields)
      const blob = prepareSyncPayload(snapshot)
      const { data, error } = await withTimeout(supabaseClient
        .from('user_settings')
        .upsert({ user_id: session.user.id, blob }, { onConflict: 'user_id' })
        .select('updated_at')
        .single())
      if (error) throw error
      const updatedAt = data?.updated_at ?? null
      const current = readJson(localSettingsPath)
      const changedDuringPush = current?._sync?.localUpdatedAt
        && current._sync.localUpdatedAt !== settings?._sync?.localUpdatedAt
      const persisted = changedDuringPush ? current : settings
      const next = {
        ...persisted,
        _sync: {
          ...(persisted?._sync ?? {}),
          dirty: changedDuringPush ? persisted?._sync?.dirty === true : false,
          dirtyFields: changedDuringPush ? (persisted?._sync?.dirtyFields ?? []) : [],
          ownerUserId: session.user.id,
          serverUpdatedAt: updatedAt,
          shadow: blob,
        },
      }
      writeJson(localSettingsPath, next)
      setState({ status: 'synced', updatedAt })
      return { settings: next, updatedAt, overwritten: false }
    } catch (err) {
      setState({ status: 'error', message: 'Settings could not sync. Local settings are unchanged.' })
      throw err
    }
  }

  async function pullNow(currentSettings) {
    setState({ status: 'syncing' })
    try {
      const session = await requireSession()
      const local = readJson(localSettingsPath)
      const current = currentSettings ?? local
      const { data, error } = await withTimeout(supabaseClient
        .from('user_settings')
        .select('blob, updated_at')
        .eq('user_id', session.user.id)
        .maybeSingle())
      if (error) throw error
      if (!data) {
        if (local?._sync?.ownerUserId === session.user.id && local?._sync?.dirty === true) return pushNow(current)
        setState({ status: 'idle' })
        return null
      }

      const remote = prepareSyncPayload(data.blob ?? {})
      const latestLocal = readJson(localSettingsPath)
      const changedDuringPull = latestLocal?._sync?.localUpdatedAt !== local?._sync?.localUpdatedAt
        || latestLocal?._sync?.dirty !== local?._sync?.dirty
      const effectiveLocal = changedDuringPull ? latestLocal : local
      const effectiveCurrent = changedDuringPull
        ? (getCurrentSettings?.() ?? { ...current, ...selectSyncSettings(latestLocal), _sync: latestLocal._sync })
        : current

      if (effectiveLocal?._sync?.ownerUserId === session.user.id && effectiveLocal?._sync?.dirty === true) {
        const mergedForPush = mergeSyncedSettings(effectiveCurrent, remote)
        for (const field of effectiveLocal._sync.dirtyFields ?? []) {
          if (Object.hasOwn(effectiveCurrent, field)) mergedForPush[field] = effectiveCurrent[field]
          else {
            const tombstone = dirtyTombstone(field)
            if (tombstone === undefined) delete mergedForPush[field]
            else mergedForPush[field] = tombstone
          }
        }
        mergedForPush._sync = { ...effectiveLocal._sync, shadow: remote }
        return pushNow(mergedForPush)
      }

      const localPayload = selectSyncSettings(effectiveCurrent)
      const merged = mergeSyncedSettings(effectiveCurrent, remote)
      merged._sync = {
        ...(merged._sync ?? {}),
        dirty: false,
        dirtyFields: [],
        ownerUserId: session.user.id,
        serverUpdatedAt: data.updated_at,
        shadow: remote,
      }
      const overwritten = Object.keys(localPayload).length > 0
        && !isDeepStrictEqual(localPayload, selectSyncSettings(merged))
      writeJson(localSettingsPath, merged)
      setState({ status: 'synced', updatedAt: data.updated_at, overwritten })
      return { settings: merged, updatedAt: data.updated_at, overwritten }
    } catch (err) {
      setState({ status: 'error', message: 'Settings could not sync. Local settings are unchanged.' })
      throw err
    }
  }

  return {
    push: (settings) => supabaseClient ? enqueue(() => pushNow(settings)) : null,
    pull: (currentSettings) => supabaseClient ? enqueue(() => pullNow(currentSettings)) : null,
    getState: () => state,
    on: events.on.bind(events),
    off: events.off.bind(events),
  }
}
