import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAuthManager } from '../src/main/auth.mjs'

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(),
  }
}

function fakeSupabase() {
  let listener = () => {}
  let session = null
  let redirectTo = ''
  const createClientImpl = (_url, _key, options) => {
    const storage = options.auth.storage
    return {
      auth: {
        onAuthStateChange(cb) {
          listener = cb
          return { data: { subscription: { unsubscribe() {} } } }
        },
        async getSession() { return { data: { session }, error: null } },
        async signInWithOAuth({ options: oauthOptions }) {
          redirectTo = oauthOptions.redirectTo
          storage.setItem('supabase.pkce.verifier', 'verifier-must-stay-secret')
          return { data: { url: 'https://example.supabase.co/auth/v1/authorize' }, error: null }
        },
        async exchangeCodeForSession(code) {
          assert.equal(code, 'one-time-code')
          session = {
            access_token: 'access-token-must-stay-secret',
            refresh_token: 'refresh-token-must-stay-secret',
            user: { id: 'user-1', email: 'person@example.com' },
          }
          storage.setItem('supabase.session', JSON.stringify(session))
          listener('SIGNED_IN', session)
          return { data: { session }, error: null }
        },
        async signOut() { session = null; listener('SIGNED_OUT', null); return { error: null } },
        startAutoRefresh() {},
        stopAutoRefresh() {},
      },
      async rpc() { return { error: null } },
    }
  }
  return { createClientImpl, redirectTo: () => redirectTo }
}

test('OAuth IPC smoke writes only an encrypted session and validates callback state', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-auth-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const opened = []
  const fake = fakeSupabase()
  const manager = createAuthManager({
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'publishable-key',
    configDir,
    safeStorage: fakeSafeStorage(),
    openExternal: async (url) => { opened.push(url) },
    createClientImpl: fake.createClientImpl,
  })
  t.after(() => manager.close())

  assert.deepEqual(await manager.initialize(), { available: true, signedIn: false })
  await manager.signInWithGitHub()
  assert.deepEqual(opened, ['https://example.supabase.co/auth/v1/authorize'])
  await assert.rejects(manager.signInWithGoogle(), /already in progress/)

  const callback = new URL(fake.redirectTo())
  callback.searchParams.set('code', 'one-time-code')
  callback.searchParams.set('state', 'wrong-state')
  await assert.rejects(manager.handleDeepLink(callback.toString()), /state did not match/)

  await manager.signInWithGitHub()
  const retryCallback = new URL(fake.redirectTo())
  const retryState = retryCallback.searchParams.get('state')
  retryCallback.searchParams.set('code', 'one-time-code')
  retryCallback.searchParams.set('state', retryState)
  assert.equal(await manager.handleDeepLink(retryCallback.toString()), true)
  assert.deepEqual(manager.getState(), { available: true, signedIn: true, email: 'person@example.com' })

  const encrypted = fs.readFileSync(path.join(configDir, 'session.enc')).toString()
  assert.match(encrypted, /^encrypted:/)
  assert.doesNotMatch(encrypted, /access-token|refresh-token|person@example\.com|verifier-must/)

  await manager.signOut()
  assert.equal(fs.existsSync(path.join(configDir, 'session.enc')), false)
  assert.deepEqual(manager.getState(), { available: true, signedIn: false })
})

test('unreachable auth initializes as signed out without throwing', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-offline-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const manager = createAuthManager({
    supabaseUrl: 'https://offline.supabase.co',
    supabaseKey: 'publishable-key',
    configDir,
    safeStorage: fakeSafeStorage(),
    openExternal: async () => {},
    createClientImpl: () => ({
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => { throw new Error('offline') },
        stopAutoRefresh() {},
      },
    }),
  })
  t.after(() => manager.close())
  assert.deepEqual(await manager.initialize(), { available: true, signedIn: false })
})

test('session restore is time-bounded so offline auth never delays local startup', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-timeout-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const manager = createAuthManager({
    supabaseUrl: 'https://offline.supabase.co',
    supabaseKey: 'publishable-key',
    configDir,
    safeStorage: fakeSafeStorage(),
    openExternal: async () => {},
    bootstrapTimeoutMs: 5,
    createClientImpl: () => ({
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => new Promise(() => {}),
      },
    }),
  })
  t.after(() => manager.close())
  assert.deepEqual(await manager.initialize(), { available: true, signedIn: false })
})

test('failed session refresh degrades to signed out with a passive notice', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-refresh-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const session = {
    expires_at: (Date.now() + 20) / 1000,
    user: { id: 'user-1', email: 'person@example.com' },
  }
  const manager = createAuthManager({
    supabaseUrl: 'https://example.supabase.co',
    supabaseKey: 'publishable-key',
    configDir,
    safeStorage: fakeSafeStorage(),
    openExternal: async () => {},
    refreshLeewayMs: 0,
    refreshTimeoutMs: 20,
    createClientImpl: () => ({
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session }, error: null }),
        refreshSession: async () => { throw new Error('offline') },
      },
    }),
  })
  t.after(() => manager.close())
  assert.equal((await manager.initialize()).signedIn, true)
  const state = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('refresh event timed out')), 500)
    manager.on('session-changed', (next) => {
      if (!next.signedIn && next.notice) {
        clearTimeout(timeout)
        resolve(next)
      }
    })
  })
  assert.deepEqual(state, {
    available: true,
    signedIn: false,
    notice: 'Your session expired. Sign in again to resume settings sync.',
  })
})

test('sign-out clears the encrypted local session even when Supabase is offline', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-signout-'))
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }))
  const session = { user: { id: 'user-1', email: 'person@example.com' } }
  const manager = createAuthManager({
    supabaseUrl: 'https://offline.supabase.co',
    supabaseKey: 'publishable-key',
    configDir,
    safeStorage: fakeSafeStorage(),
    openExternal: async () => {},
    signOutTimeoutMs: 5,
    createClientImpl: (_url, _key, options) => {
      options.auth.storage.setItem('supabase.session', JSON.stringify(session))
      return {
        auth: {
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          getSession: async () => ({ data: { session }, error: null }),
          signOut: async () => new Promise(() => {}),
        },
      }
    },
  })
  t.after(() => manager.close())
  assert.equal((await manager.initialize()).signedIn, true)
  await manager.signOut()
  assert.deepEqual(manager.getState(), { available: true, signedIn: false })
  assert.equal(fs.existsSync(path.join(configDir, 'session.enc')), false)
})
