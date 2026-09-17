import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  UNPUBLISHED,
  buildNpmReleaseRecord,
  fetchNpmReleaseRecord,
  writeNpmReleaseRecord,
} from '../../apps/site/scripts/sync-npm-release.mjs'
import { npmCliRoute } from '../../apps/site/src/data/npm-cli.mjs'

const INTEGRITY = `sha512-${'A'.repeat(86)}==`

function registryDocument(versions) {
  return {
    name: 'contextcake',
    versions: Object.fromEntries(versions.map((version) => [
      version,
      { name: 'contextcake', version, dist: { integrity: INTEGRITY, tarball: `https://registry.npmjs.org/contextcake/-/contextcake-${version}.tgz` } },
    ])),
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('published only when npm has the app release version', () => {
  assert.deepEqual(buildNpmReleaseRecord(registryDocument(['0.0.0', '1.2.3']), '1.2.3'), {
    published: true,
    version: '1.2.3',
    tarballIntegrity: INTEGRITY,
  })
  // The 0.0.0 placeholder, or an older release, is not this release.
  assert.deepEqual(buildNpmReleaseRecord(registryDocument(['0.0.0', '1.2.2']), '1.2.3'), UNPUBLISHED)
  assert.deepEqual(buildNpmReleaseRecord({}, '1.2.3'), UNPUBLISHED)
  assert.throws(() => buildNpmReleaseRecord(registryDocument(['1.2.3']), 'app-v1.2.3'), /X\.Y\.Z/)
})

test('a deprecated version, a foreign name, or an unusable integrity is not a route', () => {
  const deprecated = registryDocument(['1.2.3'])
  deprecated.versions['1.2.3'].deprecated = 'broken build'
  assert.deepEqual(buildNpmReleaseRecord(deprecated, '1.2.3'), UNPUBLISHED)

  const foreign = registryDocument(['1.2.3'])
  foreign.versions['1.2.3'].name = 'context-cake'
  assert.deepEqual(buildNpmReleaseRecord(foreign, '1.2.3'), UNPUBLISHED)

  for (const integrity of [undefined, 'sha1-abc', `sha512-${'A'.repeat(20)}"><script>`]) {
    const document = registryDocument(['1.2.3'])
    document.versions['1.2.3'].dist.integrity = integrity
    assert.deepEqual(buildNpmReleaseRecord(document, '1.2.3'), UNPUBLISHED)
  }
})

test('reads the public registry without credentials', async () => {
  const seen = []
  const { record, reason } = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    fetchImpl: async (url, options) => {
      seen.push({ url, options })
      return jsonResponse(registryDocument(['1.2.3']))
    },
  })
  assert.equal(record.published, true)
  assert.equal(reason, null)
  assert.deepEqual(seen.map((entry) => entry.url), ['https://registry.npmjs.org/contextcake'])
  assert.equal(seen[0].options.headers.Authorization, undefined)
})

test('a 404 records unpublished without retrying', async () => {
  let calls = 0
  const { record, reason } = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ error: 'Not found' }, 404)
    },
  })
  assert.deepEqual(record, UNPUBLISHED)
  assert.equal(calls, 1)
  assert.match(reason, /no contextcake package/)
})

test('a network failure records unpublished instead of failing an offline build', async () => {
  let calls = 0
  const { record, reason } = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    },
  })
  assert.deepEqual(record, UNPUBLISHED)
  assert.equal(calls, 3)
  assert.match(reason, /ENOTFOUND/)
})

test('a server error is retried, then recorded unpublished', async () => {
  const statuses = [503, 200]
  const recovered = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    retryDelayMs: 0,
    fetchImpl: async () => {
      const status = statuses.shift()
      return jsonResponse(status === 200 ? registryDocument(['1.2.3']) : {}, status)
    },
  })
  assert.equal(recovered.record.published, true)

  let calls = 0
  const failed = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({}, 500)
    },
  })
  assert.deepEqual(failed.record, UNPUBLISHED)
  assert.equal(calls, 3)
  assert.match(failed.reason, /HTTP 500/)
})

test('invalid registry JSON records unpublished', async () => {
  const { record } = await fetchNpmReleaseRecord({
    appVersion: '1.2.3',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }),
  })
  assert.deepEqual(record, UNPUBLISHED)
})

test('writes the record as formatted JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-release-'))
  try {
    const url = pathToFileURL(join(dir, 'npm-release.json'))
    await writeNpmReleaseRecord({ published: true, version: '1.2.3', tarballIntegrity: INTEGRITY }, url)
    assert.equal(await readFile(url, 'utf8'), `{\n  "published": true,\n  "version": "1.2.3",\n  "tarballIntegrity": "${INTEGRITY}"\n}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the committed default record offers no npm route', async () => {
  const committed = JSON.parse(await readFile(new URL('../../apps/site/src/data/npm-release.json', import.meta.url), 'utf8'))
  assert.deepEqual(committed, UNPUBLISHED)
})

test('the page route pins the version and names the executable it resolved', () => {
  const app = { version: '1.2.3' }
  assert.equal(npmCliRoute(UNPUBLISHED, app), null)
  // A record left from an older release never pins a version the page does not link.
  assert.equal(npmCliRoute({ published: true, version: '1.2.2', tarballIntegrity: INTEGRITY }, app), null)
  const route = npmCliRoute({ published: true, version: '1.2.3', tarballIntegrity: INTEGRITY }, app)
  assert.equal(route.install, 'npm install -g contextcake@1.2.3')
  assert.equal(route.npx, 'npx --yes contextcake@1.2.3 init')
  assert.match(route.setup, /^contextcake init\ncontextcake source add \S+ --path \S+$/)
  for (const connect of [route.connectClaude, route.connectCodex]) {
    assert.match(connect, /-- "\$\(command -v contextcake\)" mcp$/)
  }
})
