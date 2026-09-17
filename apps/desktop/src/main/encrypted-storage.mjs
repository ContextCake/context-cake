// A small encrypted key/value file, main-process only.
//
// Extracted from auth.mjs, which needed exactly one of these for the Supabase
// PKCE verifier and session (`session.enc`). Integration credentials want the
// same thing with different contents and a different lifetime, so the file
// name is now a parameter and the two stores never share a blast radius: a
// corrupt or cleared session must not take a GitHub connection with it.
//
// What safeStorage does and does not buy: the bytes on disk are encrypted with
// a key held in the login Keychain, so another *user* on the machine cannot
// read them, and neither can a backup that captures the file alone. It does
// NOT protect against code already running as this user — that process can ask
// safeStorage to decrypt too. Anything stored here should therefore be
// revocable, and the docs/security threat model says so out loud rather than
// implying a stronger guarantee than exists.
//
// On Linux, safeStorage reports encryption as available even when it found no
// keyring: it falls back to the `basic_text` backend, whose key is a constant
// compiled into Chromium. A file written that way is obfuscated, not
// encrypted, so this store treats `basic_text` as unavailable and keeps values
// in memory only. The backend is only known once the app is ready (`unknown`
// before), so it is checked at each use, never cached at construction.

import fs from 'node:fs'
import path from 'node:path'

// Backends that do not protect the bytes: a fixed key, or none chosen yet.
const WEAK_BACKENDS = new Set(['basic_text'])

export function createEncryptedStorage({
  configDir,
  safeStorage,
  canWrite = () => true,
  fileName = 'session.enc',
  isReady = () => true,
  now = () => new Date(),
}) {
  const file = path.join(configDir, fileName)
  const memory = new Map()

  const encryptionAvailable = () => {
    try {
      if (safeStorage?.isEncryptionAvailable() !== true) return false
      // Linux only; macOS and Windows have no such method.
      const backend = safeStorage.getSelectedStorageBackend?.()
      if (WEAK_BACKENDS.has(backend)) return false
      if (backend === 'unknown' && isReady()) return false
      return true
    } catch {
      return false
    }
  }

  // A file that exists but cannot be decrypted or parsed is moved aside, never
  // treated as empty: the next write would otherwise replace it, and a keyring
  // that is only locked or reset for now would cost the user every stored
  // credential for good. The copy keeps the bytes for a manual recovery.
  const setAside = () => {
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    try { fs.renameSync(file, `${file}.unreadable-${stamp}`) } catch { /* already gone */ }
  }

  const readMap = () => {
    if (!encryptionAvailable()) return Object.fromEntries(memory)
    let encrypted
    try {
      encrypted = fs.readFileSync(file)
    } catch {
      // Missing (or unreadable as a file at all) reads as "nothing stored".
      return {}
    }
    try {
      const plaintext = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(plaintext)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Stale or foreign key material, or corrupt bytes: handled below.
    }
    setAside()
    return {}
  }

  const writeMap = (values) => {
    if (!encryptionAvailable()) {
      memory.clear()
      for (const [key, value] of Object.entries(values)) memory.set(key, value)
      return
    }
    fs.mkdirSync(configDir, { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(values))
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
    fs.renameSync(temporary, file)
    try { fs.chmodSync(file, 0o600) } catch { /* best effort on non-POSIX test hosts */ }
  }

  const clear = () => {
    memory.clear()
    try { fs.rmSync(file) } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  return {
    file,
    /**
     * 'persistent' when values reach disk encrypted, 'memory' when they last
     * only as long as this process (no keyring, or a fixed-key backend).
     */
    mode() {
      return encryptionAvailable() ? 'persistent' : 'memory'
    },
    getItem(key) {
      const value = readMap()[key]
      return typeof value === 'string' ? value : null
    },
    setItem(key, value) {
      if (!canWrite()) return
      writeMap({ ...readMap(), [key]: value })
    },
    removeItem(key) {
      if (!canWrite()) return
      const next = readMap()
      delete next[key]
      if (Object.keys(next).length === 0) clear()
      else writeMap(next)
    },
    clear,
  }
}
