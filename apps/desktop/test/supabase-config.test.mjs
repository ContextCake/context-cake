import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isPublicSupabaseKey, loadSupabaseConfig } from '../src/main/supabase-config.mjs'

const GENERATOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'generate-supabase-config.mjs')

function legacyKey(role) {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`
}

function generate(env, out) {
  execFileSync(process.execPath, [GENERATOR], {
    env: { ...process.env, CC_ACCOUNTS: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', ...env, CC_SUPABASE_CONFIG_OUT: out },
    stdio: 'pipe',
  })
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

test('config priority is environment, userData, then packaged public config', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const packaged = path.join(dir, 'packaged.json')
  fs.writeFileSync(packaged, JSON.stringify({ url: 'https://packaged.supabase.co', anonKey: 'sb_publishable_packaged' }))

  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {}, packaged), {
    url: 'https://packaged.supabase.co', anonKey: 'sb_publishable_packaged',
  })
  fs.mkdirSync(path.join(dir, 'user'))
  fs.writeFileSync(path.join(dir, 'user', 'supabase.json'), JSON.stringify({ url: 'https://user.supabase.co', anonKey: 'sb_publishable_user' }))
  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {}, packaged), {
    url: 'https://user.supabase.co', anonKey: 'sb_publishable_user',
  })
  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {
    SUPABASE_URL: 'https://env.supabase.co', SUPABASE_ANON_KEY: legacyKey('anon'),
  }, packaged), { url: 'https://env.supabase.co', anonKey: legacyKey('anon') })
})

test('only publishable or legacy anon keys can enter a desktop build', () => {
  assert.equal(isPublicSupabaseKey('sb_publishable_public'), true)
  assert.equal(isPublicSupabaseKey(legacyKey('anon')), true)
  assert.equal(isPublicSupabaseKey('sb_secret_never_package'), false)
  assert.equal(isPublicSupabaseKey(legacyKey('service_role')), false)
  assert.equal(isPublicSupabaseKey('unknown-key'), false)

  assert.deepEqual(loadSupabaseConfig('/missing', {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: legacyKey('service_role'),
  }), { url: '', anonKey: '' })
})

test('non-HTTPS project URLs leave auth unavailable', () => {
  assert.deepEqual(loadSupabaseConfig('/missing', {
    SUPABASE_URL: 'http://example.test', SUPABASE_ANON_KEY: 'public',
  }), { url: '', anonKey: '' })
})

test('accounts are off unless the build asks for them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-accounts-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'supabase-config.json')

  // Default build: no credentials needed, and the file is still written —
  // electron-builder treats a missing extraResources source as a build failure.
  assert.deepEqual(generate({}, out), { accounts: 'disabled' })

  // Leftover credentials in the environment must not switch accounts on.
  assert.deepEqual(generate({
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x',
  }, out), { accounts: 'disabled' })
})

test('a disabled build stays disabled whatever the environment says', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-disabled-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const packaged = path.join(dir, 'packaged.json')
  fs.writeFileSync(packaged, JSON.stringify({ accounts: 'disabled' }))
  fs.mkdirSync(path.join(dir, 'user'))
  fs.writeFileSync(path.join(dir, 'user', 'supabase.json'), JSON.stringify({
    url: 'https://user.supabase.co', anonKey: 'sb_publishable_user',
  }))

  // The marker describes the artifact users downloaded, so it outranks both a
  // userData file and the environment. Otherwise a stale VITE_SUPABASE_* in
  // someone's shell quietly turns sign-in back on in a build that shipped
  // without it.
  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {
    SUPABASE_URL: 'https://env.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_env',
  }, packaged), { url: '', anonKey: '' })
})

test('CC_ACCOUNTS=1 still demands valid public credentials', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-enabled-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'supabase-config.json')

  assert.throws(() => generate({ CC_ACCOUNTS: '1' }, out), /requires SUPABASE_URL/)
  assert.throws(() => generate({
    CC_ACCOUNTS: '1', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'sb_secret_never',
  }, out), /publishable key or a legacy anon JWT/)
  assert.throws(() => generate({
    CC_ACCOUNTS: '1', SUPABASE_URL: 'http://example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x',
  }, out), /valid HTTPS URL/)

  assert.deepEqual(generate({
    CC_ACCOUNTS: '1', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x',
  }, out), { accounts: 'enabled', url: 'https://example.supabase.co', anonKey: 'sb_publishable_x' })

  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {}, out), {
    url: 'https://example.supabase.co', anonKey: 'sb_publishable_x',
  })
})
