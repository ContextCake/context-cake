import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertSafeLocalSettings,
  assertSafeSyncPayload,
  combineManifestSources,
  createSettingsSync,
  mergeSyncedSettings,
  overlaySyncShadow,
  prepareSyncPayload,
  scrubSettings,
  selectManifestProfiles,
  selectSyncSettings,
} from '../src/main/settings-sync.mjs'

test('scrubSettings recursively removes absolute paths and indirect secrets', () => {
  const scrubbed = scrubSettings({
    theme: 'dark',
    profiles: [{ root: '/Users/dana/company', nested: { cache: 'C:\\Users\\dana\\cache' } }],
    sources: [
      { name: 'team', path: '~/ContextCake/team', credential: 'keychain:contextcake/team' },
      { name: 'mcp', tokenEnv: 'GITHUB_TOKEN', command: 'node', args: ['./server.mjs'] },
    ],
  })
  assert.deepEqual(scrubbed, {
    theme: 'dark',
    profiles: [{ root: { __scrubbed: 'path' }, nested: { cache: { __scrubbed: 'path' } } }],
    sources: [
      { name: 'team', path: { __scrubbed: 'path' }, credential: { __scrubbed: 'secret' } },
      { name: 'mcp', tokenEnv: { __scrubbed: 'secret' }, command: { __scrubbed: 'execution' }, args: { __scrubbed: 'execution' } },
    ],
  })
})

test('prepareSyncPayload allowlists metadata and rejects credentials or context', () => {
  assert.deepEqual(prepareSyncPayload({ theme: 'light', updateCheck: true, privateNotes: 'never upload' }), {
    theme: 'light',
    updateCheck: true,
  })
  assert.throws(
    () => prepareSyncPayload({ sources: [{ credential: 'Bearer definitely-a-secret' }] }),
    /possible credential/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ content: 'company strategy' }),
    /context content/,
  )
  assert.deepEqual(prepareSyncPayload({ sources: [{ repo: 'git@github.com:ContextCake/private-pack.git' }] }), {
    sources: [{ repo: 'git@github.com:ContextCake/private-pack.git' }],
  })
  assert.throws(
    () => prepareSyncPayload(JSON.parse('{"profiles":[{"__proto__":{"polluted":true}}]}')),
    /unsafe object key/,
  )
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', headers: {} }] }),
    /unsupported source field/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ value: { __scrubbed: 'path', credential: 'plain' } }),
    /malformed scrub marker/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ sources: [{ name: 'mcp', args: ['--api-key=short-but-secret'] }] }),
    /possible credential/,
  )
})

test('Pack files and local registry stay out of sync while identity metadata is safe', () => {
  const manifest = {
    packs: {
      contextcake: {
        installedVersions: [{ version: '0.1.0', checksum: 'sha256:local-only' }],
      },
    },
    sources: [{
      name: 'pack-contextcake',
      level: 0,
      source: 'okf-local',
      path: '/Users/dana/Library/Application Support/ContextCake/packs/contextcake/0.1.0',
      origin: 'pack:contextcake@0.1.0',
    }],
  }
  assert.deepEqual(selectSyncSettings(manifest), { sources: manifest.sources })
  assert.deepEqual(prepareSyncPayload(manifest), {
    sources: [{
      name: 'pack-contextcake',
      level: 0,
      source: 'okf-local',
      path: { __scrubbed: 'path' },
      origin: 'pack:contextcake@0.1.0',
    }],
  })
})

test('embedded paths and path-shaped object keys are scrubbed or rejected', () => {
  assert.deepEqual(prepareSyncPayload({ sources: [{ name: 'team', path: './team', args: ['--config=/Users/dana/private.json'] }] }), {
    sources: [{ name: 'team', path: { __scrubbed: 'path' }, args: { __scrubbed: 'execution' } }],
  })
  assert.throws(
    () => scrubSettings({ '/Users/dana/private.json': 'value' }),
    /absolute path in an object key/,
  )
  assert.deepEqual(prepareSyncPayload({ sources: [{ name: 'team:/Users/dana/company', level: 1 }] }), {
    sources: [{ name: { __scrubbed: 'path' }, level: 1 }],
  })
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', origin: 'https://example.com/repo?token=plainsecret' }] }),
    /possible credential/,
  )
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', repo: 'https://user:password@example.com/private.git' }] }),
    /possible credential/,
  )
  assert.deepEqual(
    prepareSyncPayload({ sources: [{ name: 'team', origin: 'https://example.com/repo?root=/Users/dana/company' }] }),
    { sources: [{ name: 'team', origin: { __scrubbed: 'path' } }] },
  )
  assert.deepEqual(
    prepareSyncPayload({ sources: [{ name: 'team', origin: 'https://example.com/repo?root=%252FUsers%252Fdana%252Fcompany' }] }),
    { sources: [{ name: 'team', origin: { __scrubbed: 'path' } }] },
  )
  assert.deepEqual(
    prepareSyncPayload({ sources: [{ name: 'team:%2FUsers%2Fdana%2Fcompany', level: 1 }] }),
    { sources: [{ name: { __scrubbed: 'path' }, level: 1 }] },
  )
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', origin: 'https://example.com/#token%3Dplainsecret' }] }),
    /possible credential/,
  )
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', repo: 'api_key%25253Dsupersecret' }] }),
    /possible credential/,
  )
  assert.throws(
    () => assertSafeLocalSettings({ sources: [{ name: 'team', repo: 'token%25253Dghp_abcdefghijklmnopqrstuvwxyz1234567890' }] }),
    /plaintext/,
  )
  for (const malformed of [
    'api_key%3Dsupersecret%ZZ',
    'token%3Dghp_abcdefghijklmnopqrstuvwxyz1234567890%ZZ',
    'https://example.com/?api_key%3Dsupersecret%ZZ',
  ]) {
    assert.throws(
      () => prepareSyncPayload({ sources: [{ name: 'team', repo: malformed }] }),
      /malformed encoded value/,
    )
    assert.throws(
      () => assertSafeLocalSettings({ sources: [{ name: 'team', repo: malformed }] }),
      /malformed encoded value/,
    )
  }
  assert.deepEqual(prepareSyncPayload({ sources: [{ name: 'team 100% ready' }] }), {
    sources: [{ name: 'team 100% ready' }],
  })
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', repo: 'prefix_api_key=supersecret' }] }),
    /possible credential/,
  )
  const excessivelyEncoded = Array.from({ length: 10 }).reduce((value) => encodeURIComponent(value), 'token=secret')
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', repo: excessivelyEncoded }] }),
    /excessively encoded/,
  )
})

test('pending source metadata survives an unrelated local source addition', () => {
  const pending = [{ name: 'company', level: 0, source: 'mcp', command: { __scrubbed: 'execution' } }]
  const local = [{ name: 'personal', level: 3, path: '/Users/local/personal' }]
  assert.deepEqual(combineManifestSources(local, pending), [...pending, ...local])

  const configured = [{ name: 'company', level: 0, source: 'mcp', command: 'node', args: ['./company.mjs'] }]
  assert.deepEqual(combineManifestSources(configured, pending), configured)
  assert.deepEqual(combineManifestSources(local, pending, 'user-a', 'user-a'), [...pending, ...local])
  assert.deepEqual(combineManifestSources(local, pending, 'user-a', 'user-b'), local)
  assert.deepEqual(combineManifestSources(local, pending, null, 'user-b'), local)
})

test('remotely derived profile metadata stays with the account that pulled it', () => {
  const profiles = {
    company: { layers: [{ name: 'private-graph', level: 0, source: 'mcp' }] },
  }
  assert.deepEqual(selectManifestProfiles(profiles, 'user-a', 'user-a'), profiles)
  assert.equal(selectManifestProfiles(profiles, 'user-a', 'user-b'), undefined)
  assert.deepEqual(selectManifestProfiles(profiles, null, 'user-b'), profiles)
})

test('sync shadow is discarded when a different account signs in', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-account-scope-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({ _sync: { ownerUserId: 'user-a' } }))
  let uploaded = null
  const supabaseClient = {
    from() {
      return {
        upsert(row) {
          uploaded = row.blob
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-15T05:00:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-b' } }) },
    supabaseClient,
    localSettingsPath: file,
  })
  await sync.push({
    theme: 'light',
    _sync: {
      ownerUserId: 'user-a',
      shadow: { theme: 'dark', sources: [{ name: 'company', level: 0 }] },
    },
  })
  assert.deepEqual(uploaded, { theme: 'light' })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))._sync.ownerUserId, 'user-b')
})

test('another account cannot use stale dirty state to overwrite a missing row', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-account-no-row-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const current = {
    theme: 'light',
    _sync: {
      ownerUserId: 'user-a',
      dirty: true,
      dirtyFields: ['theme'],
      shadow: { theme: 'dark', sources: [{ name: 'user-a-private', level: 0 }] },
    },
  }
  const accountAProfiles = {
    company: { layers: [{ name: 'user-a-private', level: 0, source: 'mcp' }] },
  }
  assert.equal(selectManifestProfiles(accountAProfiles, 'user-a', 'user-b'), undefined)
  fs.writeFileSync(file, JSON.stringify(current))
  const uploads = []
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
        },
        upsert(row) {
          uploads.push(row.blob)
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-15T05:10:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-b' } }) },
    supabaseClient,
    localSettingsPath: file,
  })

  assert.equal(await sync.pull(current), null)
  assert.deepEqual(uploads, [])
  await sync.push(current)
  assert.deepEqual(uploads, [{ theme: 'light' }])
})

test('another account remote row wins over stale dirty bookkeeping', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-account-existing-row-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const current = {
    theme: 'light',
    _sync: { ownerUserId: 'user-a', dirty: true, dirtyFields: ['theme'] },
  }
  const accountAProfiles = {
    company: { layers: [{ name: 'user-a-private', level: 0, source: 'mcp' }] },
  }
  assert.equal(selectManifestProfiles(accountAProfiles, 'user-a', 'user-b'), undefined)
  fs.writeFileSync(file, JSON.stringify(current))
  let uploaded = false
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({
            data: {
              blob: { theme: 'dark', sources: [{ name: 'user-b-team', level: 1 }] },
              updated_at: '2026-07-15T05:20:00Z',
            },
            error: null,
          }) }) }
        },
        upsert() {
          uploaded = true
          return { select: () => ({ single: async () => ({ data: null, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-b' } }) },
    supabaseClient,
    localSettingsPath: file,
  })

  const pulled = await sync.pull(current)
  assert.equal(uploaded, false)
  assert.deepEqual(selectSyncSettings(pulled.settings), {
    theme: 'dark',
    sources: [{ name: 'user-b-team', level: 1 }],
  })
  assert.equal(pulled.settings._sync.ownerUserId, 'user-b')
})

test('safe remote shadow survives an unrelated local edit without persisting machine values', () => {
  const shadow = prepareSyncPayload({
    theme: 'dark',
    sources: [{ name: 'team', level: 1, path: '/Users/remote/team' }],
    profiles: { company: { layers: [{ name: 'graph', level: 0, source: 'mcp', command: 'node' }] } },
  })
  const combined = overlaySyncShadow(shadow, { theme: 'light' }, ['theme'])
  assert.deepEqual(prepareSyncPayload(combined), {
    theme: 'light',
    sources: [{ name: 'team', level: 1, path: { __scrubbed: 'path' } }],
    profiles: { company: { layers: [{ name: 'graph', level: 0, source: 'mcp', command: { __scrubbed: 'execution' } }] } },
  })
  assert.doesNotMatch(JSON.stringify(combined), /Users\/remote|\"node\"/)
})

test('remote MCP executable fields are quarantined and can only restore local values', () => {
  const remote = prepareSyncPayload({
    sources: [{ name: 'company', level: 0, source: 'mcp', command: '/tmp/evil', args: ['--steal'] }],
  })
  assert.deepEqual(remote.sources[0], {
    name: 'company',
    level: 0,
    source: 'mcp',
    command: { __scrubbed: 'execution' },
    args: { __scrubbed: 'execution' },
  })
  assert.deepEqual(mergeSyncedSettings({
    sources: [{ name: 'company', level: 0, source: 'mcp', command: 'node', args: ['./trusted.mjs'] }],
  }, remote).sources[0], {
    name: 'company', level: 0, source: 'mcp', command: 'node', args: ['./trusted.mjs'],
  })
  assert.deepEqual(mergeSyncedSettings({ sources: [] }, remote).sources[0], {
    name: 'company', level: 0, source: 'mcp',
  })
})

test('manifest-v2 profiles round-trip while local layer execution stays local', () => {
  const local = {
    profiles: {
      default: {
        layers: [{ name: 'personal', level: 3, path: '/Users/dana/kb' }],
      },
      company: {
        layers: [{ name: 'graph', level: 0, source: 'mcp', command: 'node', args: ['./graph.mjs'] }],
      },
    },
  }
  const remote = prepareSyncPayload(local)
  assert.deepEqual(remote, {
    profiles: {
      default: { layers: [{ name: 'personal', level: 3, path: { __scrubbed: 'path' } }] },
      company: { layers: [{ name: 'graph', level: 0, source: 'mcp', command: { __scrubbed: 'execution' }, args: { __scrubbed: 'execution' } }] },
    },
  })
  assert.deepEqual(mergeSyncedSettings(local, remote), local)
  assert.deepEqual(mergeSyncedSettings({}, remote), {
    profiles: {
      default: { layers: [{ name: 'personal', level: 3 }] },
      company: { layers: [{ name: 'graph', level: 0, source: 'mcp' }] },
    },
  })

  const withoutCompany = prepareSyncPayload({ profiles: { default: local.profiles.default } })
  assert.deepEqual(mergeSyncedSettings(local, withoutCompany), {
    profiles: { default: local.profiles.default },
  })
})

test('local settings reject plaintext PII and credentials before disk persistence', () => {
  assert.doesNotThrow(() => assertSafeLocalSettings({
    sources: [{ path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN', credential: 'keychain:contextcake/team' }],
  }))
  assert.throws(() => assertSafeLocalSettings({ profiles: [{ email: 'person@example.com' }] }), /plaintext/)
  assert.throws(() => assertSafeLocalSettings({ sources: [{ accessToken: 'plain-secret' }] }), /plaintext/)
})

test('remote scrub markers preserve machine-local values during pull', () => {
  const merged = mergeSyncedSettings(
    { theme: 'dark', sources: [{ name: 'team', path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN' }] },
    { theme: 'light', sources: [{ name: 'team', path: { __scrubbed: 'path' }, tokenEnv: { __scrubbed: 'secret' } }] },
  )
  assert.deepEqual(merged, {
    theme: 'light',
    sources: [{ name: 'team', path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN' }],
  })
})

test('a dirty offline edit is pushed before a remote pull', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-sync-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({ theme: 'light', _sync: { ownerUserId: 'user-1', dirty: true } }))
  let operation = ''
  const supabaseClient = {
    from() {
      return {
        upsert() {
          operation = 'upsert'
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T20:00:00Z' }, error: null }) }) }
        },
        select() {
          operation = 'select'
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
  })
  const result = await sync.pull()
  assert.equal(operation, 'upsert')
  assert.equal(result.overwritten, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))._sync.dirty, false)
})

test('dirty fields override remote while untouched remote metadata is retained', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-reconcile-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({
    theme: 'light',
    _sync: { ownerUserId: 'user-1', dirty: true, dirtyFields: ['theme'], localUpdatedAt: '2026-07-14T20:00:00Z' },
  }))
  let uploaded = null
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({
            data: { blob: { theme: 'dark', profiles: [{ id: 'work', name: 'Work' }] }, updated_at: '2026-07-14T19:00:00Z' },
            error: null,
          }) }) }
        },
        upsert(row) {
          uploaded = row.blob
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T21:00:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
  })
  await sync.pull({ theme: 'light' })
  assert.deepEqual(uploaded, { theme: 'light', profiles: [{ id: 'work', name: 'Work' }] })
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'sources'), false)
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'profiles'), false)
})

test('a dirty profile deletion uploads a tombstone that clears a second client', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-profile-delete-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({
    _sync: { ownerUserId: 'user-1', dirty: true, dirtyFields: ['profiles'], localUpdatedAt: '2026-07-14T20:00:00Z' },
  }))
  let uploaded = null
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({
            data: {
              blob: { profiles: { company: { layers: [{ name: 'graph', source: 'mcp' }] } } },
              updated_at: '2026-07-14T19:00:00Z',
            },
            error: null,
          }) }) }
        },
        upsert(row) {
          uploaded = row.blob
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T21:00:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
  })

  await sync.pull({})
  assert.deepEqual(uploaded.profiles, {})
  assert.deepEqual(mergeSyncedSettings({ profiles: { company: { layers: [] } } }, uploaded).profiles, {})
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'profiles'), false)
})

test('a timed-out write settles before the next queued write starts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-sync-order-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let resolveFirst
  const uploads = []
  const supabaseClient = {
    from() {
      return {
        upsert(row) {
          uploads.push(row.blob)
          const index = uploads.length
          return {
            select: () => ({
              single: () => index === 1
                ? new Promise((resolve) => { resolveFirst = resolve })
                : Promise.resolve({ data: { updated_at: '2026-07-14T22:00:00Z' }, error: null }),
            }),
          }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
    operationTimeoutMs: 5,
  })

  await assert.rejects(sync.push({ theme: 'light' }), /timed out/)
  const second = sync.push({ theme: 'dark' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(uploads.length, 1)
  resolveFirst({ data: { updated_at: '2026-07-14T21:00:00Z' }, error: null })
  await second
  assert.deepEqual(uploads, [{ theme: 'light' }, { theme: 'dark' }])
})

test('an edit made during a slow pull is reconciled and pushed instead of overwritten', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-pull-race-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const initial = { theme: 'light', _sync: { dirty: false, localUpdatedAt: '2026-07-14T20:00:00Z' } }
  fs.writeFileSync(file, JSON.stringify(initial))
  let finishPull
  let uploaded
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: () => new Promise((resolve) => { finishPull = resolve }) }) }
        },
        upsert(row) {
          uploaded = row.blob
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T22:00:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
    getCurrentSettings: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  })

  const pull = sync.pull(initial)
  await new Promise((resolve) => setImmediate(resolve))
  fs.writeFileSync(file, JSON.stringify({
    theme: 'dark',
    _sync: { ownerUserId: 'user-1', dirty: true, dirtyFields: ['theme'], localUpdatedAt: '2026-07-14T21:00:00Z' },
  }))
  finishPull({
    data: { blob: { theme: 'light', profiles: [{ id: 'work', name: 'Work' }] }, updated_at: '2026-07-14T20:30:00Z' },
    error: null,
  })
  await pull

  assert.deepEqual(uploaded, { theme: 'dark', profiles: [{ id: 'work', name: 'Work' }] })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark')
})

test('a stalled database request becomes a non-blocking sync error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-sync-timeout-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
    operationTimeoutMs: 5,
  })

  await assert.rejects(sync.pull({ theme: 'dark' }), /timed out/)
  assert.deepEqual(sync.getState(), {
    status: 'error',
    message: 'Settings could not sync. Local settings are unchanged.',
  })
})
