// The encrypted key/value file behind session.enc and tokens.enc.
//
// Two failures here are silent in the field: a Linux machine with no keyring,
// where Chromium "encrypts" with a key compiled into every copy of the browser
// and says encryption is available; and a file that stops decrypting, which
// used to read as empty and be overwritten by the next save.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createEncryptedStorage } from '../src/main/encrypted-storage.mjs'
import { createGithubConnections } from '../src/main/github-connections.mjs'

const TOKEN = 'gh' + 'p_' + 'Q'.repeat(36)

function fakeSafeStorage({ available = true, backend, key = 'k1' } = {}) {
  const state = { available, backend, key }
  return {
    state,
    isEncryptionAvailable: () => state.available,
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => state.backend }),
    encryptString: (value) => Buffer.from(`${state.key}:${Buffer.from(value).toString('base64')}`),
    decryptString: (buffer) => {
      const [key, body] = buffer.toString().split(':')
      if (key !== state.key) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from(body, 'base64').toString()
    },
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-encrypted-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a keyring-backed store writes encrypted bytes and reports persistent', (t) => {
  const configDir = tempDir(t)
  const storage = createEncryptedStorage({ configDir, safeStorage: fakeSafeStorage({ backend: 'gnome_libsecret' }), fileName: 'tokens.enc' })
  storage.setItem('a', 'secret-value')
  assert.equal(storage.mode(), 'persistent')
  assert.ok(fs.existsSync(path.join(configDir, 'tokens.enc')))
  assert.doesNotMatch(fs.readFileSync(path.join(configDir, 'tokens.enc'), 'utf8'), /secret-value/)
  // macOS has no backend method at all; that is the normal persistent case.
  const mac = createEncryptedStorage({ configDir, safeStorage: fakeSafeStorage(), fileName: 'mac.enc' })
  assert.equal(mac.mode(), 'persistent')
})

test('the basic_text backend is treated as no encryption: memory only, nothing on disk', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'basic_text' })
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc' })
  storage.setItem('a', 'secret-value')
  assert.equal(storage.getItem('a'), 'secret-value')
  assert.equal(storage.mode(), 'memory')
  assert.equal(fs.existsSync(path.join(configDir, 'tokens.enc')), false)
})

test('the backend is checked at use time: unknown before ready is not a verdict, unknown after is', (t) => {
  const configDir = tempDir(t)
  let ready = false
  const safeStorage = fakeSafeStorage({ backend: 'unknown' })
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc', isReady: () => ready })
  assert.equal(storage.mode(), 'persistent')

  ready = true
  assert.equal(storage.mode(), 'memory')

  // The same instance picks up the real backend once Chromium has chosen one.
  safeStorage.state.backend = 'kwallet5'
  assert.equal(storage.mode(), 'persistent')
  safeStorage.state.backend = 'basic_text'
  assert.equal(storage.mode(), 'memory')
})

test('an undecryptable file is moved aside, never overwritten by the next write', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  const stamp = new Date('2026-09-17T01:02:03.456Z')
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc', now: () => stamp })
  storage.setItem('a', 'first')
  const original = fs.readFileSync(path.join(configDir, 'tokens.enc'))

  // The keyring's key changed (a reset keyring, a restored home directory).
  safeStorage.state.key = 'k2'
  assert.equal(storage.getItem('a'), null)
  const asideName = 'tokens.enc.unreadable-2026-09-17T01-02-03-456Z'
  assert.deepEqual(fs.readdirSync(configDir).sort(), [asideName])
  assert.deepEqual(fs.readFileSync(path.join(configDir, asideName)), original)

  storage.setItem('b', 'second')
  assert.deepEqual(fs.readFileSync(path.join(configDir, asideName)), original)
  assert.equal(storage.getItem('b'), 'second')
})

test('corrupt JSON inside a decryptable file is set aside the same way', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc', now: () => new Date(0) })
  fs.writeFileSync(path.join(configDir, 'tokens.enc'), safeStorage.encryptString('{not json'))
  assert.equal(storage.getItem('a'), null)
  assert.ok(fs.existsSync(path.join(configDir, 'tokens.enc.unreadable-1970-01-01T00-00-00-000Z')))
  // A missing file is simply empty, with nothing renamed.
  assert.equal(storage.getItem('a'), null)
  assert.equal(fs.readdirSync(configDir).length, 1)
})

test('memory-only mode never deletes an encrypted file an earlier keyring session wrote', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc' }).setItem('a', 'from-keyring-session')
  const file = path.join(configDir, 'tokens.enc')
  const original = fs.readFileSync(file)

  // Next launch finds no keyring.
  safeStorage.state.backend = 'basic_text'
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc' })
  storage.setItem('b', 'memory-only')
  storage.removeItem('b')
  assert.deepEqual(fs.readFileSync(file), original)
  storage.clear()
  assert.deepEqual(fs.readFileSync(file), original)

  // The same through the GitHub broker: add, then remove the last connection.
  const connections = createGithubConnections({ configDir, safeStorage })
  connections.add({ login: 'octocat', token: TOKEN })
  assert.equal(connections.remove('github.com/octocat'), true)
  assert.deepEqual(fs.readFileSync(file), original)

  // With the keyring back, the earlier value is still there.
  safeStorage.state.backend = 'gnome_libsecret'
  assert.equal(createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc' }).getItem('a'), 'from-keyring-session')
})

test('a write is refused when an unreadable file could not be moved aside', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  const stamp = new Date('2026-09-17T01:02:03.456Z')
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc', now: () => stamp })
  storage.setItem('a', 'first')
  const original = fs.readFileSync(path.join(configDir, 'tokens.enc'))
  safeStorage.state.key = 'k2'

  // Something already occupies the aside name, so the rename fails.
  const blocker = path.join(configDir, 'tokens.enc.unreadable-2026-09-17T01-02-03-456Z')
  fs.mkdirSync(blocker)
  fs.writeFileSync(path.join(blocker, 'x'), 'x')
  assert.throws(() => storage.setItem('b', 'second'), /could not be moved aside/)
  assert.deepEqual(fs.readFileSync(path.join(configDir, 'tokens.enc')), original)

  // Once the name is free the next write sets the file aside and proceeds.
  fs.rmSync(blocker, { recursive: true })
  storage.setItem('b', 'second')
  assert.deepEqual(fs.readFileSync(blocker), original)
  assert.equal(storage.getItem('b'), 'second')
})

test('at most three unreadable copies are kept, oldest removed first', (t) => {
  const configDir = tempDir(t)
  const safeStorage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  let clock = Date.parse('2026-09-17T00:00:00.000Z')
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: 'tokens.enc', now: () => new Date(clock) })
  for (let round = 1; round <= 5; round += 1) {
    safeStorage.state.key = `k${round}`
    storage.setItem('a', `round ${round}`)
    safeStorage.state.key = `other${round}`
    clock += 60_000
    assert.equal(storage.getItem('a'), null)
  }
  const aside = fs.readdirSync(configDir).filter((name) => name.startsWith('tokens.enc.unreadable-')).sort()
  assert.deepEqual(aside, [
    'tokens.enc.unreadable-2026-09-17T00-03-00-000Z',
    'tokens.enc.unreadable-2026-09-17T00-04-00-000Z',
    'tokens.enc.unreadable-2026-09-17T00-05-00-000Z',
  ])
})

test('GitHub connections report whether they will survive a restart', (t) => {
  const configDir = tempDir(t)
  const keyring = createGithubConnections({ configDir, safeStorage: fakeSafeStorage({ backend: 'gnome_libsecret' }) })
  assert.equal(keyring.storageMode(), 'persistent')

  const noKeyring = createGithubConnections({ configDir: tempDir(t), safeStorage: fakeSafeStorage({ backend: 'basic_text' }) })
  noKeyring.add({ login: 'octocat', token: TOKEN })
  assert.equal(noKeyring.storageMode(), 'memory')
  // Still usable for this session; never written to disk.
  assert.equal(noKeyring.list()[0].login, 'octocat')
  assert.equal(fs.existsSync(noKeyring.file), false)
})
