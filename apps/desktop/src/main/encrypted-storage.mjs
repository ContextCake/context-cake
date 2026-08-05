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

import fs from 'node:fs'
import path from 'node:path'

export function createEncryptedStorage({ configDir, safeStorage, canWrite = () => true, fileName = 'session.enc' }) {
  const file = path.join(configDir, fileName)
  const memory = new Map()

  const encryptionAvailable = () => {
    try { return safeStorage?.isEncryptionAvailable() === true } catch { return false }
  }

  const readMap = () => {
    if (!encryptionAvailable()) return Object.fromEntries(memory)
    try {
      const encrypted = fs.readFileSync(file)
      const plaintext = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(plaintext)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      // Missing, locked, or stale Keychain material reads as "nothing stored".
      return {}
    }
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
