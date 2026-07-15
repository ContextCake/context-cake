import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isPublicSupabaseKey, loadSupabaseConfig } from '../src/main/supabase-config.mjs'

function legacyKey(role) {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`
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
