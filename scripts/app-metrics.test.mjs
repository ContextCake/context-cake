import assert from 'node:assert/strict'
import test from 'node:test'
import { loadReleases, renderMarkdown, summarizeAppMetrics } from './app-metrics.mjs'

const releases = [
  {
    tag_name: 'app-v0.4.0',
    published_at: '2026-08-03T12:00:00Z',
    assets: [
      { name: 'ContextCake-0.4.0-arm64.dmg', download_count: 7 },
      { name: 'ContextCake-0.4.0-arm64-mac.zip', download_count: 3 },
      { name: 'install-ping.txt', download_count: 4 },
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
  { tag_name: 'console-v0.2.0', assets: [{ name: 'source.tgz', download_count: 99 }] },
]

test('summarizes app release assets without pretending downloads are unique people', () => {
  const report = summarizeAppMetrics(releases)
  assert.deepEqual(report.totals, {
    dmgDownloads: 9,
    zipDownloads: 4,
    confirmedFirstLaunches: 4,
    trackedInstallReleases: 1,
  })
  assert.deepEqual(report.releases.map((row) => row.confirmedFirstLaunches), [4, null])

  const markdown = renderMarkdown(report)
  assert.match(markdown, /DMG downloads: \*\*9\*\*/)
  assert.match(markdown, /app-v0\.3\.0 \| 2 \| 1 \| not tracked/)
  assert.match(markdown, /directional, not unique-person counts/)
  assert.doesNotMatch(markdown, /app-v9\.9\.9/)
  assert.doesNotMatch(markdown, /console-v/)
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
