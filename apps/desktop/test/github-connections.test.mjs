// The GitHub credential broker.
//
// The properties worth pinning are the ones that fail silently if broken: a
// secret that leaks into the object handed to the renderer, a secret sitting in
// plaintext on disk, or a credential injected without the host binding that
// makes it safe to send. Each has its own test below.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  connectionAlias,
  createGithubConnections,
  githubHosts,
  verifyGithubToken,
} from '../src/main/github-connections.mjs'

// Token-shaped strings are built at runtime so no credential-shaped literal is
// ever committed to a file.
const TOKEN = 'gh' + 'u_' + 'T'.repeat(36)
const OTHER = 'gh' + 'p_' + 'Z'.repeat(36)

// Stands in for Electron's safeStorage. Reversible but not plaintext, so a test
// can prove the token is not readable straight off disk.
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'),
    decryptString: (b) => Buffer.from(b.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8'),
  }
}

function tempStore(opts) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conn-'))
  const store = createGithubConnections({ configDir, safeStorage: fakeSafeStorage(opts), now: () => '2026-08-04T00:00:00.000Z' })
  return { store, configDir, cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }) }
}

test('a connection round-trips and injects host-bound', () => {
  const { store, cleanup } = tempStore()
  try {
    const added = store.add({ login: 'octocat', token: TOKEN })
    assert.equal(added.alias, 'github.com/octocat')
    // Bound twice: the API host the adapter calls, and the host a clone names.
    assert.deepEqual(store.injectionMap(), {
      'github.com/octocat': { secret: TOKEN, host: 'api.github.com', gitHost: 'github.com' },
    })
  } finally { cleanup() }
})

test('list() returns metadata and never the secret', () => {
  const { store, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    const listed = store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].login, 'octocat')
    // The whole payload, not just the fields we remembered to check — this
    // object crosses the IPC bridge to a sandboxed renderer.
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(TOKEN))
    assert.ok(!('token' in listed[0]), 'no token key should exist at all')
  } finally { cleanup() }
})

test('the token is not readable in plaintext on disk', () => {
  const { store, configDir, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    const onDisk = fs.readFileSync(path.join(configDir, 'tokens.enc'))
    assert.doesNotMatch(onDisk.toString('utf8'), new RegExp(TOKEN))
    assert.doesNotMatch(onDisk.toString('base64'), new RegExp(TOKEN))
    const mode = fs.statSync(path.join(configDir, 'tokens.enc')).mode & 0o777
    assert.equal(mode, 0o600, 'credential file must not be group/world readable')
  } finally { cleanup() }
})

test('credentials live in tokens.enc, not the auth session file', () => {
  // Separate files so clearing a sign-in cannot take a GitHub connection with
  // it, and vice versa.
  const { store, configDir, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    assert.ok(fs.existsSync(path.join(configDir, 'tokens.enc')))
    assert.ok(!fs.existsSync(path.join(configDir, 'session.enc')))
  } finally { cleanup() }
})

test('several accounts coexist, each bound to its own host', () => {
  const { store, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    store.add({ login: 'work', token: OTHER, host: 'ghe.acme.com' })
    assert.deepEqual(store.injectionMap(), {
      'github.com/octocat': { secret: TOKEN, host: 'api.github.com', gitHost: 'github.com' },
      'ghe.acme.com/work': { secret: OTHER, host: 'ghe.acme.com', gitHost: 'ghe.acme.com' },
    })
    assert.deepEqual(store.list().map((c) => c.alias), ['ghe.acme.com/work', 'github.com/octocat'])
  } finally { cleanup() }
})

test('disconnecting drops the secret from the injection map', () => {
  const { store, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    assert.equal(store.remove('github.com/octocat'), true)
    assert.deepEqual(store.injectionMap(), {})
    assert.equal(store.remove('github.com/nobody'), false)
  } finally { cleanup() }
})

test('git credentials are offered only for the matching host', () => {
  const { store, cleanup } = tempStore()
  try {
    store.add({ login: 'octocat', token: TOKEN })
    assert.deepEqual(store.gitCredentialFor('github.com'), {
      username: 'x-access-token', password: TOKEN, login: 'octocat',
    })
    assert.equal(store.gitCredentialFor('evil.example'), null)
  } finally { cleanup() }
})

test('without OS encryption the store stays in memory rather than writing plaintext', () => {
  const { store, configDir, cleanup } = tempStore({ available: false })
  try {
    store.add({ login: 'octocat', token: TOKEN })
    assert.deepEqual(store.injectionMap(), {
      'github.com/octocat': { secret: TOKEN, host: 'api.github.com', gitHost: 'github.com' },
    })
    assert.ok(!fs.existsSync(path.join(configDir, 'tokens.enc')), 'must never fall back to an unencrypted file')
  } finally { cleanup() }
})

test('a login or token that cannot form a usable alias is rejected', () => {
  const { store, cleanup } = tempStore()
  try {
    assert.throws(() => store.add({ login: '', token: TOKEN }), /login/)
    assert.throws(() => store.add({ login: 'octocat', token: '' }), /token/)
    // ':' is outside the manifest's alias grammar, so it must not slip in.
    assert.throws(() => store.add({ login: 'bad:login', token: TOKEN }), /not a usable credential alias/)
  } finally { cleanup() }
})

test('host normalization maps github.com and GHES to the right API base', () => {
  assert.deepEqual(githubHosts('github.com'), {
    gitHost: 'github.com', apiHost: 'api.github.com', apiBase: 'https://api.github.com',
  })
  assert.deepEqual(githubHosts('https://ghe.acme.com/'), {
    gitHost: 'ghe.acme.com', apiHost: 'ghe.acme.com', apiBase: 'https://ghe.acme.com/api/v3',
  })
  assert.throws(() => githubHosts('https://user@ghe.acme.com'), /without credentials/)
  assert.throws(() => githubHosts('https://ghe.acme.com/custom/path'), /without credentials, a path/)
  assert.throws(() => githubHosts('ghe.acme.com:8443'), /standard HTTPS port/)
  assert.equal(connectionAlias('github.com', 'octocat'), 'github.com/octocat')
})

test('verification names the account and turns failures into readable messages', async () => {
  const ok = async (url, init) => {
    assert.equal(url, 'https://api.github.com/user')
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(init.redirect, 'manual', 'verification must not follow a redirect while credentialed')
    return { ok: true, status: 200, json: async () => ({ login: 'octocat' }) }
  }
  assert.deepEqual(await verifyGithubToken({ token: TOKEN, fetchImpl: ok }), {
    login: 'octocat', gitHost: 'github.com', apiHost: 'api.github.com',
  })

  const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) })
  await assert.rejects(verifyGithubToken({ token: TOKEN, fetchImpl: status(401) }), /rejected that token/)
  await assert.rejects(verifyGithubToken({ token: TOKEN, fetchImpl: status(403) }), /refused the request/)
  await assert.rejects(verifyGithubToken({ token: TOKEN, fetchImpl: status(302) }), /redirected/)
})
