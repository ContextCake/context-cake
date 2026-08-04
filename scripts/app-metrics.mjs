#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

export const INSTALL_METRIC_ASSET = 'install-ping.txt'
const APP_TAG = /^app-v/

export function summarizeAppMetrics(releases) {
  const rows = releases
    .filter((release) => !release.draft && APP_TAG.test(release.tag_name ?? ''))
    .map((release) => {
      const assets = Array.isArray(release.assets) ? release.assets : []
      const sum = (pattern) => assets
        .filter((asset) => pattern.test(asset.name ?? ''))
        .reduce((total, asset) => total + Number(asset.download_count ?? 0), 0)
      const installAsset = assets.find((asset) => asset.name === INSTALL_METRIC_ASSET)
      return {
        release: release.tag_name,
        publishedAt: release.published_at ?? null,
        dmgDownloads: sum(/\.dmg$/i),
        zipDownloads: sum(/\.zip$/i),
        confirmedFirstLaunches: installAsset ? Number(installAsset.download_count ?? 0) : null,
      }
    })

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      dmgDownloads: rows.reduce((total, row) => total + row.dmgDownloads, 0),
      zipDownloads: rows.reduce((total, row) => total + row.zipDownloads, 0),
      confirmedFirstLaunches: rows.reduce(
        (total, row) => total + (row.confirmedFirstLaunches ?? 0),
        0,
      ),
      trackedInstallReleases: rows.filter((row) => row.confirmedFirstLaunches !== null).length,
    },
    releases: rows,
  }
}

export function renderMarkdown(report) {
  const installSummary = report.totals.trackedInstallReleases > 0
    ? String(report.totals.confirmedFirstLaunches)
    : 'not available until the first instrumented release'
  const lines = [
    '# ContextCake app metrics',
    '',
    `- DMG downloads: **${report.totals.dmgDownloads}**`,
    `- ZIP/update downloads: **${report.totals.zipDownloads}**`,
    `- Confirmed first launches: **${installSummary}**`,
    '',
    '| Release | DMG downloads | ZIP/update downloads | Confirmed first launches | Published |',
    '|---|---:|---:|---:|---|',
  ]
  for (const row of report.releases) {
    lines.push(
      `| ${row.release} | ${row.dmgDownloads} | ${row.zipDownloads} | ${row.confirmedFirstLaunches ?? 'not tracked'} | ${row.publishedAt?.slice(0, 10) ?? 'unknown'} |`,
    )
  }
  lines.push(
    '',
    '_Counts come from GitHub Release asset downloads. They are directional, not unique-person counts: a person can download more than once, ZIP downloads can include automatic updates, and the first instrumented release counts existing users who upgrade and launch it._',
  )
  return lines.join('\n') + '\n'
}

export async function loadReleases({ repository, token, fetchImpl = globalThis.fetch }) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: HTTP ${response.status}`)
    }
    const batch = await response.json()
    if (!Array.isArray(batch)) throw new Error('GitHub releases request returned an invalid response.')
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

async function main() {
  const json = process.argv.includes('--json')
  const repository = process.env.GITHUB_REPOSITORY || 'ContextCake/context-cake'
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const releases = await loadReleases({ repository, token })
  const report = summarizeAppMetrics(releases)
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
