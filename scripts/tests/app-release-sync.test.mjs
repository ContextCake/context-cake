import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildAppReleaseRecord,
  compareAppReleaseTags,
  fetchAppReleaseRecord,
  parseChecksums,
  renderDownloadRedirect,
  selectStableAppRelease,
} from '../../apps/site/scripts/sync-app-release.mjs'

function release(version, overrides = {}) {
  const tag = `app-v${version}`
  const base = `https://github.com/ContextCake/context-cake/releases/download/${tag}`
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-08-12T20:35:33Z',
    html_url: `https://github.com/ContextCake/context-cake/releases/tag/${tag}`,
    assets: [
      { name: `ContextCake-${version}-arm64.dmg`, size: 120, browser_download_url: `${base}/ContextCake-${version}-arm64.dmg` },
      { name: `ContextCake-${version}-arm64-mac.zip`, size: 110, browser_download_url: `${base}/ContextCake-${version}-arm64-mac.zip` },
      { name: 'SHA256SUMS', size: 190, browser_download_url: `${base}/SHA256SUMS` },
    ],
    ...overrides,
  }
}

test('selects the highest published stable app version', () => {
  const selected = selectStableAppRelease([
    release('1.9.0'),
    release('1.10.0'),
    release('2.0.0', { prerelease: true }),
    { ...release('3.0.0'), tag_name: 'console-v3.0.0' },
  ])
  assert.equal(selected.tag_name, 'app-v1.10.0')
  assert.ok(compareAppReleaseTags('app-v1.10.0', 'app-v1.9.0') > 0)
})

test('builds a release record only when both packaged artifacts have checksums', () => {
  const checksumText = `${'a'.repeat(64)}  ContextCake-1.2.3-arm64.dmg\n${'b'.repeat(64)}  ContextCake-1.2.3-arm64-mac.zip\n`
  const record = buildAppReleaseRecord(release('1.2.3'), checksumText)
  assert.equal(record.tag, 'app-v1.2.3')
  assert.equal(record.artifacts.dmg.sha256, 'a'.repeat(64))
  assert.equal(record.artifacts.updaterZip.sha256, 'b'.repeat(64))
  assert.equal(
    renderDownloadRedirect(record),
    '/download/mac https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg 302\n',
  )

  assert.throws(
    () => buildAppReleaseRecord(release('1.2.3'), `${'a'.repeat(64)}  ContextCake-1.2.3-arm64.dmg\n`),
    /SHA256SUMS is missing ContextCake-1\.2\.3-arm64-mac\.zip/,
  )
})

test('adds the MCPB route only when its released bytes are checksum-pinned', () => {
  const published = release('1.2.3', {
    assets: [
      ...release('1.2.3').assets,
      { name: 'ContextCake-1.2.3.mcpb', size: 42, browser_download_url: 'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3.mcpb' },
    ],
  })
  const checksums = [
    `${'a'.repeat(64)}  ContextCake-1.2.3-arm64.dmg`,
    `${'b'.repeat(64)}  ContextCake-1.2.3-arm64-mac.zip`,
    `${'c'.repeat(64)}  ContextCake-1.2.3.mcpb`,
  ].join('\n')
  const record = buildAppReleaseRecord(published, checksums)
  assert.equal(record.artifacts.mcpb?.sha256, 'c'.repeat(64))

  assert.throws(
    () => buildAppReleaseRecord(published, checksums.replace(`\n${'c'.repeat(64)}  ContextCake-1.2.3.mcpb`, '')),
    /SHA256SUMS is missing ContextCake-1\.2\.3\.mcpb/,
  )
})

test('rejects malformed checksum manifests', () => {
  assert.throws(() => parseChecksums('not a checksum'), /Invalid SHA256SUMS line/)
})

test('syncs one exact published tag and probes every recorded artifact', async () => {
  const published = release('1.2.3')
  const checksumText = `${'a'.repeat(64)}  ContextCake-1.2.3-arm64.dmg\n${'b'.repeat(64)}  ContextCake-1.2.3-arm64-mac.zip\n`
  const seen = []
  const fetchImpl = async (url, options = {}) => {
    seen.push([url, options.method ?? 'GET', options.redirect ?? 'follow'])
    if (url.endsWith('/releases/tags/app-v1.2.3')) {
      return new Response(JSON.stringify(published), { status: 200 })
    }
    if (url.endsWith('/SHA256SUMS')) return new Response(checksumText, { status: 200 })
    if (url.endsWith('.dmg') || url.endsWith('.zip')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/artifact' },
      })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const record = await fetchAppReleaseRecord({ tag: 'app-v1.2.3', token: 'test-token', fetchImpl })

  assert.equal(record.tag, 'app-v1.2.3')
  assert.deepEqual(seen.map((entry) => entry[0]), [
    'https://api.github.com/repos/ContextCake/context-cake/releases/tags/app-v1.2.3',
    'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/SHA256SUMS',
    'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg',
    'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64-mac.zip',
  ])
  assert.deepEqual(seen.slice(2).map((entry) => entry.slice(1)), [
    ['GET', 'manual'],
    ['GET', 'manual'],
  ])
})

test('rejects a release whose advertised Mac artifact is not downloadable', async () => {
  const published = release('1.2.3')
  const checksumText = `${'a'.repeat(64)}  ContextCake-1.2.3-arm64.dmg\n${'b'.repeat(64)}  ContextCake-1.2.3-arm64-mac.zip\n`
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/tags/app-v1.2.3')) {
      return new Response(JSON.stringify(published), { status: 200 })
    }
    if (url.endsWith('/SHA256SUMS')) return new Response(checksumText, { status: 200 })
    if (url.endsWith('.dmg')) return new Response('missing', { status: 404 })
    throw new Error(`unexpected URL ${url}`)
  }

  await assert.rejects(
    fetchAppReleaseRecord({ tag: 'app-v1.2.3', fetchImpl }),
    /ContextCake-1\.2\.3-arm64\.dmg is not downloadable \(HTTP 404\)/,
  )
})
