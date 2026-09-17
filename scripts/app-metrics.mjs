#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { RELEASE_PLATFORMS } from './release-platforms.mjs'

export const MCPB_INSTALL_METRIC_ASSET = 'mcpb-install-ping.txt'
export const NPM_PACKAGE = 'contextcake'
export const HOMEBREW_CASK = 'contextcake'
const APP_TAG = /^app-v/
const STABLE_TAG = /^app-v(\d+\.\d+\.\d+)$/

const sumNullable = (values) => values.some((value) => value !== null)
  ? values.reduce((total, value) => total + (value ?? 0), 0)
  : null

// Downloads and first launches for one release, counted by platform-table row.
// Names come from the table, so a stray file that happens to end in .zip is not
// counted as an app download. A row's pre-table counter (install-ping.txt) is
// read too, so releases from before the table keep their launch counts.
function platformCounts(release, assets) {
  const count = (name) => {
    const asset = name && assets.find((candidate) => candidate.name === name)
    return asset ? Number(asset.download_count ?? 0) : null
  }
  const version = STABLE_TAG.exec(release.tag_name)?.[1]
  const platforms = {}
  for (const row of RELEASE_PLATFORMS) {
    platforms[row.id] = {
      installerDownloads: version ? count(row.installerName(version)) ?? 0 : 0,
      updaterDownloads: version && row.updaterName(version) ? count(row.updaterName(version)) ?? 0 : 0,
      confirmedFirstLaunches: sumNullable([count(row.pingAsset), count(row.legacyPingAsset)]),
    }
  }
  return platforms
}

export function summarizeAppMetrics(releases) {
  const rows = releases
    .filter((release) => !release.draft && APP_TAG.test(release.tag_name ?? ''))
    .map((release) => {
      const assets = Array.isArray(release.assets) ? release.assets : []
      const sum = (pattern) => assets
        .filter((asset) => pattern.test(asset.name ?? ''))
        .reduce((total, asset) => total + Number(asset.download_count ?? 0), 0)
      const mcpbInstallAsset = assets.find((asset) => asset.name === MCPB_INSTALL_METRIC_ASSET)
      const platforms = platformCounts(release, assets)
      const perRow = Object.values(platforms)
      return {
        release: release.tag_name,
        publishedAt: release.published_at ?? null,
        installerDownloads: perRow.reduce((total, row) => total + row.installerDownloads, 0),
        updaterDownloads: perRow.reduce((total, row) => total + row.updaterDownloads, 0),
        mcpbDownloads: sum(/\.mcpb$/i),
        confirmedFirstLaunches: sumNullable(perRow.map((row) => row.confirmedFirstLaunches)),
        confirmedMcpbActivations: mcpbInstallAsset ? Number(mcpbInstallAsset.download_count ?? 0) : null,
        platforms,
      }
    })

  const platforms = {}
  for (const platform of RELEASE_PLATFORMS) {
    const perRelease = rows.map((row) => row.platforms[platform.id])
    platforms[platform.id] = {
      installerDownloads: perRelease.reduce((total, row) => total + row.installerDownloads, 0),
      updaterDownloads: perRelease.reduce((total, row) => total + row.updaterDownloads, 0),
      confirmedFirstLaunches: sumNullable(perRelease.map((row) => row.confirmedFirstLaunches)),
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      installerDownloads: rows.reduce((total, row) => total + row.installerDownloads, 0),
      updaterDownloads: rows.reduce((total, row) => total + row.updaterDownloads, 0),
      mcpbDownloads: rows.reduce((total, row) => total + row.mcpbDownloads, 0),
      confirmedFirstLaunches: rows.reduce(
        (total, row) => total + (row.confirmedFirstLaunches ?? 0),
        0,
      ),
      trackedInstallReleases: rows.filter((row) => row.confirmedFirstLaunches !== null).length,
      confirmedMcpbActivations: rows.reduce(
        (total, row) => total + (row.confirmedMcpbActivations ?? 0),
        0,
      ),
      trackedMcpbReleases: rows.filter((row) => row.confirmedMcpbActivations !== null).length,
      platforms,
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
    `- Installer downloads: **${report.totals.installerDownloads}**`,
    `- Update downloads: **${report.totals.updaterDownloads}**`,
    `- MCPB bundle downloads: **${report.totals.mcpbDownloads}**`,
    `- Confirmed first launches: **${installSummary}**`,
    `- Confirmed MCPB activations: **${report.totals.trackedMcpbReleases > 0 ? report.totals.confirmedMcpbActivations : 'not available until the first instrumented bundle'}**`,
    '',
    '## By platform',
    '',
  ]
  for (const platform of RELEASE_PLATFORMS) {
    const metric = report.totals.platforms[platform.id]
    const launches = metric.confirmedFirstLaunches === null ? 'first launches not tracked' : `**${metric.confirmedFirstLaunches}** first launches`
    lines.push(`- ${platform.osLabel} (${platform.label}): **${metric.installerDownloads}** installer downloads, **${metric.updaterDownloads}** update downloads, ${launches}`)
  }
  lines.push(
    '',
    '| Release | Installer downloads | Update downloads | MCPB downloads | First launches | MCPB activations | Published |',
    '|---|---:|---:|---:|---:|---:|---|',
  )
  for (const row of report.releases) {
    lines.push(
      `| ${row.release} | ${row.installerDownloads} | ${row.updaterDownloads} | ${row.mcpbDownloads} | ${row.confirmedFirstLaunches ?? 'not tracked'} | ${row.confirmedMcpbActivations ?? 'not tracked'} | ${row.publishedAt?.slice(0, 10) ?? 'unknown'} |`,
    )
  }
  if (report.npm) {
    lines.push('', '## Package-manager aggregates', '')
    if (report.npm.versions?.unavailable) lines.push(`- npm: unavailable (${report.npm.versions.unavailable})`)
    else {
      for (const [version, metric] of Object.entries(report.npm.versions)) {
        lines.push(`- npm \`${report.npm.package}@${version}\`: **${metric.downloads}** downloads (${metric.start ?? 'unknown'} to ${metric.end ?? 'unknown'})`)
      }
    }
    if (report.homebrew?.unavailable) lines.push(`- Homebrew: unavailable (${report.homebrew.unavailable})`)
    else if (report.homebrew) lines.push(`- Homebrew \`${report.homebrew.cask}\`: **${report.homebrew.installs}** installs (${report.homebrew.start ?? 'unknown'} to ${report.homebrew.end ?? 'unknown'})`)
    else lines.push('- Homebrew: ContextCake is not present in the public 30-day cask aggregate yet.')
  }
  lines.push(
    '',
    '_Counts come from GitHub Release asset downloads. They are directional, not unique-person counts: a person can download more than once, update downloads include automatic updates, and activation is recorded only after an explicit opt-in._',
  )
  return lines.join('\n') + '\n'
}

export async function loadNpmVersionDownloads({ versions, packageName = NPM_PACKAGE, fetchImpl = globalThis.fetch }) {
  // The GitHub release list can span dozens of historical tags. Bound these
  // secondary lookups so the weekly report cannot spike npm's API or make a
  // transient rate limit hide every version's aggregate.
  const queue = [...new Set(versions)]
  const rows = new Array(queue.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor++
      const version = queue[index]
      const response = await fetchImpl(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(`${packageName}@${version}`)}`)
      if (!response.ok) throw new Error(`npm download request for ${packageName}@${version} failed: HTTP ${response.status}`)
      const data = await response.json()
      if (!Number.isSafeInteger(data.downloads) || data.downloads < 0) throw new Error(`npm download response for ${packageName}@${version} is invalid.`)
      rows[index] = [version, { downloads: data.downloads, start: data.start ?? null, end: data.end ?? null }]
    }
  }))
  return Object.fromEntries(rows)
}

export function selectHomebrewCaskInstall(analytics, cask = HOMEBREW_CASK) {
  const items = Array.isArray(analytics?.items) ? analytics.items : []
  const item = items.find((candidate) => candidate.cask === cask || candidate.name === cask)
  if (!item) return null
  const installs = Number(item.count ?? item.installs ?? item.number)
  if (!Number.isSafeInteger(installs) || installs < 0) throw new Error(`Homebrew analytics entry for ${cask} is invalid.`)
  return {
    cask,
    installs,
    start: analytics.start_date ?? analytics.start ?? null,
    end: analytics.end_date ?? analytics.end ?? null,
  }
}

export async function loadHomebrewCaskInstalls({ cask = HOMEBREW_CASK, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl('https://formulae.brew.sh/api/analytics/cask-install/30d.json')
  if (!response.ok) throw new Error(`Homebrew cask analytics request failed: HTTP ${response.status}`)
  return selectHomebrewCaskInstall(await response.json(), cask)
}

export async function collectDistributionMetrics({ repository, token, fetchImpl = globalThis.fetch }) {
  const releases = await loadReleases({ repository, token, fetchImpl })
  const report = summarizeAppMetrics(releases)
  const versions = report.releases.map((row) => row.release.slice('app-v'.length))
  const [npm, homebrew] = await Promise.all([
    loadNpmVersionDownloads({ versions, fetchImpl }).catch((error) => ({ unavailable: error.message })),
    loadHomebrewCaskInstalls({ fetchImpl }).catch((error) => ({ unavailable: error.message })),
  ])
  return {
    ...report,
    npm: { package: NPM_PACKAGE, window: 'last-month', versions: npm },
    homebrew: homebrew && !homebrew.unavailable ? { window: '30d', ...homebrew } : homebrew,
  }
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
  const report = await collectDistributionMetrics({ repository, token })
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
