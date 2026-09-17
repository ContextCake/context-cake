#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { HIDDEN_REDIRECT_LINES, assertSiteFlags, isCommerceVisible } from './site-flags.mjs'
import { RELEASE_PLATFORMS } from '../../../scripts/release-platforms.mjs'

const REPOSITORY = 'ContextCake/context-cake'
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases`
const TAG_PATTERN = /^app-v(\d+)\.(\d+)\.(\d+)$/
const DATA_URL = new URL('../src/data/app-release.json', import.meta.url)
const REDIRECTS_URL = new URL('../public/_redirects', import.meta.url)
const FLAGS_URL = new URL('../src/config/flags.json', import.meta.url)

function versionParts(tag) {
  const match = TAG_PATTERN.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

export function compareAppReleaseTags(a, b) {
  const aParts = versionParts(a)
  const bParts = versionParts(b)
  if (!aParts || !bParts) throw new Error('App release tags must use app-vX.Y.Z')
  for (let index = 0; index < 3; index += 1) {
    if (aParts[index] !== bParts[index]) return aParts[index] - bParts[index]
  }
  return 0
}

export function selectStableAppRelease(releases) {
  const stable = releases.filter((release) =>
    !release.draft && !release.prerelease && TAG_PATTERN.test(release.tag_name),
  )
  stable.sort((a, b) => compareAppReleaseTags(b.tag_name, a.tag_name))
  if (!stable[0]) throw new Error('GitHub has no published stable app-vX.Y.Z release')
  return stable[0]
}

export function parseChecksums(text) {
  const checksums = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`)
    checksums.set(match[2], match[1])
  }
  return checksums
}

function requireReleaseAsset(release, name) {
  const asset = release.assets?.find((candidate) => candidate.name === name)
  if (!asset) throw new Error(`${release.tag_name} is missing release asset ${name}`)
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`${name} has an invalid release asset size`)
  }
  const expectedPrefix = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/`
  if (!asset.browser_download_url?.startsWith(expectedPrefix)) {
    throw new Error(`${name} does not use the expected ContextCake GitHub release URL`)
  }
  return asset
}

function artifactRecord(asset, checksums) {
  if (!checksums.has(asset.name)) throw new Error(`SHA256SUMS is missing ${asset.name}`)
  return {
    name: asset.name,
    url: asset.browser_download_url,
    sha256: checksums.get(asset.name),
    bytes: asset.size,
  }
}

// One record row per platform-table row. The site follows the newest PUBLISHED
// release, and releases before the table carry Apple silicon files only, so a
// row whose installer is absent is recorded as unavailable instead of failing
// the sync. A row that is half there (installer without its update file, or a
// file without its checksum) still fails: that release is broken, not old.
// The release workflow is what refuses to publish a release missing a row.
export function buildAppReleaseRecord(release, checksumText) {
  const parts = versionParts(release.tag_name)
  if (!parts || release.draft || release.prerelease) {
    throw new Error('Release record requires a published stable app-vX.Y.Z release')
  }
  const version = parts.join('.')
  const checksumsAsset = requireReleaseAsset(release, 'SHA256SUMS')
  const checksums = parseChecksums(checksumText)
  const hasAsset = (name) => release.assets?.some((candidate) => candidate.name === name)

  const platforms = RELEASE_PLATFORMS.map((row) => {
    const installerName = row.installerName(version)
    const updaterName = row.updaterName(version)
    const available = hasAsset(installerName)
    return {
      id: row.id,
      os: row.os,
      arch: row.arch,
      osLabel: row.osLabel,
      label: row.label,
      platformName: row.platformName,
      updates: row.updates,
      downloadPath: row.downloadPath,
      downloadAliases: [...row.downloadAliases],
      available,
      installer: available ? artifactRecord(requireReleaseAsset(release, installerName), checksums) : null,
      updater: available && updaterName ? artifactRecord(requireReleaseAsset(release, updaterName), checksums) : null,
    }
  })
  if (!platforms.some((row) => row.available)) {
    throw new Error(`${release.tag_name} has no installer for any release platform`)
  }

  const mcpbName = `ContextCake-${version}.mcpb`
  const mcpb = hasAsset(mcpbName) ? artifactRecord(requireReleaseAsset(release, mcpbName), checksums) : null

  return {
    channel: 'stable',
    version,
    tag: release.tag_name,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    checksumsUrl: checksumsAsset.browser_download_url,
    platforms,
    ...(mcpb ? { mcpb } : {}),
  }
}

// Every file the record links to, for the download probe.
export function recordArtifacts(record) {
  const rows = record.platforms.filter((row) => row.available)
  return [...rows.flatMap((row) => [row.installer, row.updater]), record.mcpb].filter(Boolean)
}

// One redirect per available platform, plus its older aliases (/download/mac
// keeps pointing at Apple silicon). An unavailable platform gets no route.
export function renderDownloadRedirects(record) {
  return record.platforms
    .filter((row) => row.available)
    .flatMap((row) => [row.downloadPath, ...row.downloadAliases].map((route) => `${route} ${row.installer.url} 302\n`))
    .join('')
}

// The whole public/_redirects file. It is derived, never hand-edited: every
// build re-renders it (`npm run render-redirects`, wired as prebuild) and every
// release sync rewrites it after updating the record, so any route that must
// 302 has to be rendered here.
//
// While commerce is hidden (src/config/flags.json) the prerendered /pricing and
// /creators pages are meta-refresh stubs; HIDDEN_REDIRECT_LINES make Cloudflare
// answer a real 302 before the stub is ever served.
export function renderRedirects(record, flags = {}) {
  const lines = [renderDownloadRedirects(record)]
  if (!isCommerceVisible(flags)) {
    lines.push(...HIDDEN_REDIRECT_LINES.map((line) => `${line}\n`))
  }
  return lines.join('')
}

// Render public/_redirects from the committed release record and flags. No
// network: this is the offline half of the sync, and what prebuild runs so a
// flag flip never leaves a stale _redirects behind. The URL parameters exist so
// tests can point it at temp files.
export async function renderRedirectsFile({
  recordUrl = DATA_URL,
  flagsUrl = FLAGS_URL,
  redirectsUrl = REDIRECTS_URL,
} = {}) {
  const record = JSON.parse(await readFile(recordUrl, 'utf8'))
  const flags = assertSiteFlags(JSON.parse(await readFile(flagsUrl, 'utf8')), flagsUrl.pathname)
  const text = renderRedirects(record, flags)
  await writeFile(redirectsUrl, text)
  return text
}

function requestHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ContextCake release-site sync',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

const retryableStatus = (status) => status === 429 || status >= 500

async function requestWithRetry(fetchImpl, url, options, label) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(20_000),
        ...options,
      })
      if (!retryableStatus(response.status) || attempt === 2) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
  }
  const detail = lastError?.cause?.code ?? lastError?.cause?.message ?? lastError?.message ?? lastError
  throw new Error(`${label} request failed after 3 attempts: ${detail}`)
}

async function fetchOk(fetchImpl, url, options, label) {
  const response = await requestWithRetry(fetchImpl, url, options, label)
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return response
}

export async function fetchAppReleaseRecord({ tag, token, fetchImpl = globalThis.fetch } = {}) {
  const headers = requestHeaders(token)
  let release
  if (tag) {
    if (!TAG_PATTERN.test(tag)) throw new Error('--tag must use app-vX.Y.Z')
    const response = await fetchOk(
      fetchImpl,
      `${RELEASES_API}/tags/${encodeURIComponent(tag)}`,
      { headers },
      `GitHub release ${tag}`,
    )
    release = await response.json()
  } else {
    const response = await fetchOk(
      fetchImpl,
      `${RELEASES_API}?per_page=50`,
      { headers },
      'GitHub releases',
    )
    release = selectStableAppRelease(await response.json())
  }

  const checksumAsset = requireReleaseAsset(release, 'SHA256SUMS')
  const checksumResponse = await fetchOk(
    fetchImpl,
    checksumAsset.browser_download_url,
    { headers: { 'User-Agent': headers['User-Agent'] } },
    `${release.tag_name} checksums`,
  )
  const record = buildAppReleaseRecord(release, await checksumResponse.text())

  for (const artifact of recordArtifacts(record)) {
    const response = await requestWithRetry(fetchImpl, artifact.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': headers['User-Agent'],
      },
    }, `${artifact.name} download probe`)
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`${artifact.name} is not downloadable (HTTP ${response.status})`)
    }
  }
  return record
}

export async function writeAppReleaseRecord(record) {
  await writeFile(DATA_URL, `${JSON.stringify(record, null, 2)}\n`)
  await renderRedirectsFile()
}

function parseArgs(argv) {
  let tag
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--tag' || !argv[index + 1] || tag) {
      throw new Error('Usage: node scripts/sync-app-release.mjs [--tag app-vX.Y.Z]')
    }
    tag = argv[index + 1]
    index += 1
  }
  return { tag }
}

async function main() {
  const { tag } = parseArgs(process.argv.slice(2))
  const previous = JSON.parse(await readFile(DATA_URL, 'utf8'))
  const record = await fetchAppReleaseRecord({ tag, token: process.env.GITHUB_TOKEN })
  await writeAppReleaseRecord(record)
  const transition = previous.tag === record.tag ? record.tag : `${previous.tag} -> ${record.tag}`
  const platforms = record.platforms.filter((row) => row.available).map((row) => row.id).join(', ')
  console.log(`Synced published app release ${transition} (${platforms})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
