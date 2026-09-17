import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHomebrewCaskInstalls, loadNpmVersionDownloads, loadReleases, renderMarkdown, summarizeAppMetrics } from '../app-metrics.mjs'

const releases = [
  {
    tag_name: 'app-v0.10.0',
    published_at: '2026-09-20T12:00:00Z',
    assets: [
      { name: 'ContextCake-0.10.0-arm64.dmg', download_count: 10 },
      { name: 'ContextCake-0.10.0-arm64-mac.zip', download_count: 5 },
      { name: 'ContextCake-0.10.0-x64.dmg', download_count: 3 },
      { name: 'ContextCake-0.10.0-x64-mac.zip', download_count: 2 },
      { name: 'install-ping-mac-arm64.txt', download_count: 6 },
      { name: 'install-ping-mac-x64.txt', download_count: 1 },
      { name: 'ContextCake-0.10.0-amd64.deb', download_count: 4 },
      { name: 'install-ping-linux-x64-deb.txt', download_count: 2 },
      // A stray asset with a matching extension is not a platform download.
      { name: 'notes.zip', download_count: 40 },
    ],
  },
  {
    tag_name: 'app-v0.4.0',
    published_at: '2026-08-03T12:00:00Z',
    assets: [
      { name: 'ContextCake-0.4.0-arm64.dmg', download_count: 7 },
      { name: 'ContextCake-0.4.0-arm64-mac.zip', download_count: 3 },
      { name: 'install-ping.txt', download_count: 4 },
      { name: 'ContextCake-0.4.0.mcpb', download_count: 6 },
      { name: 'mcpb-install-ping.txt', download_count: 2 },
    ],
  },
  {
    tag_name: 'app-v0.3.0',
    published_at: '2026-07-29T12:00:00Z',
    assets: [
      { name: 'ContextCake-0.3.0-arm64.dmg', download_count: 2 },
      { name: 'ContextCake-0.3.0-arm64-mac.zip', download_count: 1 },
    ],
  },
  { tag_name: 'app-v9.9.9', draft: true, assets: [{ name: 'fake.dmg', download_count: 500 }] },
  { tag_name: 'v0.2.0', assets: [{ name: 'source.tgz', download_count: 99 }] },
]

test('counts downloads and first launches per platform row, not per file extension', () => {
  const report = summarizeAppMetrics(releases)
  assert.deepEqual(report.totals, {
    installerDownloads: 26,
    updaterDownloads: 11,
    mcpbDownloads: 6,
    confirmedFirstLaunches: 13,
    trackedInstallReleases: 2,
    confirmedMcpbActivations: 2,
    trackedMcpbReleases: 1,
    platforms: {
      'mac-arm64': { installerDownloads: 19, updaterDownloads: 9, confirmedFirstLaunches: 10 },
      'mac-x64': { installerDownloads: 3, updaterDownloads: 2, confirmedFirstLaunches: 1 },
      // The .deb has no update file; it only notifies.
      'linux-x64-deb': { installerDownloads: 4, updaterDownloads: 0, confirmedFirstLaunches: 2 },
    },
  })
  assert.deepEqual(report.releases.map((row) => row.confirmedFirstLaunches), [9, 4, null])
  // The pre-table counter belongs to the only platform those releases shipped.
  assert.deepEqual(report.releases[1].platforms['mac-arm64'], { installerDownloads: 7, updaterDownloads: 3, confirmedFirstLaunches: 4 })
  assert.deepEqual(report.releases[1].platforms['mac-x64'], { installerDownloads: 0, updaterDownloads: 0, confirmedFirstLaunches: null })

  const markdown = renderMarkdown(report)
  assert.match(markdown, /Installer downloads: \*\*26\*\*/)
  assert.match(markdown, /Linux \(Debian and Ubuntu\): \*\*4\*\* installer downloads, \*\*0\*\* update downloads, \*\*2\*\* first launches/)
  assert.match(markdown, /Mac \(Intel\): \*\*3\*\* installer downloads, \*\*2\*\* update downloads, \*\*1\*\* first launches/)
  assert.match(markdown, /app-v0\.3\.0 \| 2 \| 1 \| 0 \| not tracked/)
  assert.match(markdown, /directional, not unique-person counts/)
  assert.doesNotMatch(markdown, /app-v9\.9\.9/)
  assert.doesNotMatch(markdown, /v0\.2\.0/)
})

test('reads public channel aggregates without treating them as identities', async () => {
  const npm = await loadNpmVersionDownloads({
    versions: ['0.7.3'],
    fetchImpl: async () => ({ ok: true, json: async () => ({ downloads: 12, start: '2026-08-01', end: '2026-08-31' }) }),
  })
  assert.deepEqual(npm, { '0.7.3': { downloads: 12, start: '2026-08-01', end: '2026-08-31' } })
  const cask = await loadHomebrewCaskInstalls({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ start_date: '2026-08-01', end_date: '2026-08-31', items: [{ cask: 'contextcake', count: '7' }] }),
    }),
  })
  assert.deepEqual(cask, { cask: 'contextcake', installs: 7, start: '2026-08-01', end: '2026-08-31' })
})

test('bounds npm version lookups when the release history is long', async () => {
  let active = 0
  let peak = 0
  const versions = Array.from({ length: 20 }, (_, index) => `0.7.${index}`)
  const report = await loadNpmVersionDownloads({
    versions,
    fetchImpl: async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return { ok: true, json: async () => ({ downloads: 1 }) }
    },
  })
  assert.equal(Object.keys(report).length, versions.length)
  assert.ok(peak <= 6)
})

test('loads every GitHub releases page before calculating totals', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ tag_name: `app-v0.0.${index}` }))
  const calls = []
  const loaded = await loadReleases({
    repository: 'ContextCake/context-cake',
    token: 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('page=1') ? firstPage : [{ tag_name: 'app-v1.0.0' }],
      }
    },
  })

  assert.equal(loaded.length, 101)
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /page=2$/)
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token')
})
