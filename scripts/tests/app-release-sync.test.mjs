import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  buildAppReleaseRecord,
  compareAppReleaseTags,
  fetchAppReleaseRecord,
  parseChecksums,
  renderDownloadRedirects,
  renderRedirects,
  renderRedirectsFile,
  selectStableAppRelease,
} from '../../apps/site/scripts/sync-app-release.mjs'
import { HIDDEN_REDIRECT_LINES } from '../../apps/site/scripts/site-flags.mjs'

const HIDDEN_BLOCK = HIDDEN_REDIRECT_LINES.map((line) => `${line}\n`).join('')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)
const E = 'e'.repeat(64)

function asset(tag, name, size) {
  return { name, size, browser_download_url: `https://github.com/ContextCake/context-cake/releases/download/${tag}/${name}` }
}

// A 0.9.x-shaped release: Apple silicon only.
function release(version, overrides = {}) {
  const tag = `app-v${version}`
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-08-12T20:35:33Z',
    html_url: `https://github.com/ContextCake/context-cake/releases/tag/${tag}`,
    assets: [
      asset(tag, `ContextCake-${version}-arm64.dmg`, 120),
      asset(tag, `ContextCake-${version}-arm64-mac.zip`, 110),
      asset(tag, 'SHA256SUMS', 190),
    ],
    ...overrides,
  }
}

function armSums(version = '1.2.3') {
  return `${A}  ContextCake-${version}-arm64.dmg\n${B}  ContextCake-${version}-arm64-mac.zip\n`
}

// A release built from the platform table: Apple silicon and Intel.
function twoArchRelease(version = '1.2.3') {
  const base = release(version)
  const tag = base.tag_name
  return {
    ...base,
    assets: [
      ...base.assets,
      asset(tag, `ContextCake-${version}-x64.dmg`, 130),
      asset(tag, `ContextCake-${version}-x64-mac.zip`, 125),
    ],
  }
}

function twoArchSums(version = '1.2.3') {
  return `${armSums(version)}${C}  ContextCake-${version}-x64.dmg\n${D}  ContextCake-${version}-x64-mac.zip\n`
}

const ARM_REDIRECTS = [
  '/download/mac-arm64 https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg 302\n',
  '/download/mac https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg 302\n',
].join('')

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

test('a release with only Apple silicon assets still builds a record, with Intel marked unavailable', () => {
  const record = buildAppReleaseRecord(release('1.2.3'), armSums())
  assert.equal(record.tag, 'app-v1.2.3')
  assert.deepEqual(record.platforms.map((row) => [row.id, row.available]), [['mac-arm64', true], ['mac-x64', false], ['linux-x64-deb', false]])
  const [arm, intel, deb] = record.platforms
  assert.deepEqual(arm.installer, {
    name: 'ContextCake-1.2.3-arm64.dmg',
    url: 'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg',
    sha256: A,
    bytes: 120,
  })
  assert.equal(arm.updater.sha256, B)
  assert.equal(arm.label, 'Apple silicon')
  assert.equal(arm.osLabel, 'Mac')
  assert.equal(intel.platformName, 'Intel Mac')
  assert.equal(intel.installer, null)
  assert.equal(intel.updater, null)
  assert.equal(deb.platformName, 'Linux')
  assert.equal(deb.available, false)
  assert.equal(renderDownloadRedirects(record), ARM_REDIRECTS)
})

test('a two-architecture release records both Mac downloads and redirects each', () => {
  const record = buildAppReleaseRecord(twoArchRelease(), twoArchSums())
  assert.deepEqual(record.platforms.map((row) => [row.id, row.available, row.installer?.sha256, row.updater?.sha256]), [
    ['mac-arm64', true, A, B],
    ['mac-x64', true, C, D],
    ['linux-x64-deb', false, undefined, undefined],
  ])
  assert.equal(
    renderDownloadRedirects(record),
    `${ARM_REDIRECTS}/download/mac-x64 https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-x64.dmg 302\n`,
  )
})

test('a release with a .deb records the Linux download with no update file, and redirects both routes', () => {
  const base = twoArchRelease()
  const withDeb = { ...base, assets: [...base.assets, asset(base.tag_name, 'ContextCake-1.2.3-amd64.deb', 99)] }
  const record = buildAppReleaseRecord(withDeb, `${twoArchSums()}${E}  ContextCake-1.2.3-amd64.deb\n`)
  const deb = record.platforms.find((row) => row.id === 'linux-x64-deb')
  assert.equal(deb.available, true)
  assert.equal(deb.updates, 'notify')
  assert.equal(deb.installer.sha256, E)
  assert.equal(deb.updater, null)
  assert.match(renderDownloadRedirects(record), /\/download\/linux-x64-deb \S+ContextCake-1\.2\.3-amd64\.deb 302\n\/download\/linux \S+ContextCake-1\.2\.3-amd64\.deb 302\n$/)
})

test('a platform row needs its installer, update file, and both checksums', () => {
  assert.throws(
    () => buildAppReleaseRecord(release('1.2.3'), `${A}  ContextCake-1.2.3-arm64.dmg\n`),
    /SHA256SUMS is missing ContextCake-1\.2\.3-arm64-mac\.zip/,
  )
  const noIntelZip = twoArchRelease()
  noIntelZip.assets = noIntelZip.assets.filter((candidate) => candidate.name !== 'ContextCake-1.2.3-x64-mac.zip')
  assert.throws(() => buildAppReleaseRecord(noIntelZip, twoArchSums()), /app-v1\.2\.3 is missing release asset ContextCake-1\.2\.3-x64-mac\.zip/)
  const noInstallers = release('1.2.3', { assets: [asset('app-v1.2.3', 'SHA256SUMS', 190)] })
  assert.throws(() => buildAppReleaseRecord(noInstallers, ''), /app-v1\.2\.3 has no installer for any release platform/)
})

test('renders the commerce redirects only while commerce is hidden', () => {
  const record = buildAppReleaseRecord(release('1.2.3'), armSums())
  const download = renderDownloadRedirects(record)

  // Both slash forms of each hidden route, so the 302 answers however the
  // path arrives.
  assert.deepEqual(HIDDEN_REDIRECT_LINES, [
    '/pricing / 302',
    '/pricing/ / 302',
    '/creators /packs 302',
    '/creators/ /packs 302',
  ])
  assert.equal(renderRedirects(record, { commerceVisible: false, paymentsLive: false }), `${download}${HIDDEN_BLOCK}`)
  // A missing or malformed flags object is treated as hidden, never as visible.
  assert.equal(renderRedirects(record), `${download}${HIDDEN_BLOCK}`)
  assert.equal(renderRedirects(record, null), `${download}${HIDDEN_BLOCK}`)
  assert.equal(renderRedirects(record, { commerceVisible: true, paymentsLive: false }), download)
  // Live payments imply visible commerce even if the visibility flag lags.
  assert.equal(renderRedirects(record, { commerceVisible: false, paymentsLive: true }), download)
})

test('renders _redirects offline from the committed record and flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-redirects-'))
  try {
    const record = buildAppReleaseRecord(release('1.2.3'), armSums())
    const recordUrl = pathToFileURL(join(dir, 'app-release.json'))
    const flagsUrl = pathToFileURL(join(dir, 'flags.json'))
    const redirectsUrl = pathToFileURL(join(dir, '_redirects'))
    await writeFile(recordUrl, JSON.stringify(record))

    await writeFile(flagsUrl, JSON.stringify({ commerceVisible: false, paymentsLive: false }))
    const hidden = await renderRedirectsFile({ recordUrl, flagsUrl, redirectsUrl })
    assert.equal(hidden, `${renderDownloadRedirects(record)}${HIDDEN_BLOCK}`)
    assert.equal(await readFile(redirectsUrl, 'utf8'), hidden)

    // Flipping the flag and re-rendering removes the lines — no network involved.
    await writeFile(flagsUrl, JSON.stringify({ commerceVisible: true, paymentsLive: false }))
    const visible = await renderRedirectsFile({ recordUrl, flagsUrl, redirectsUrl })
    assert.equal(visible, renderDownloadRedirects(record))
    assert.equal(await readFile(redirectsUrl, 'utf8'), visible)

    // A malformed flags file is a loud error naming the file, never a guess.
    await writeFile(flagsUrl, JSON.stringify({ commerceVisible: 'false', paymentsLive: false }))
    await assert.rejects(renderRedirectsFile({ recordUrl, flagsUrl, redirectsUrl }), /commerceVisible must be true or false/)
    await writeFile(flagsUrl, JSON.stringify({ commerceVisible: false }))
    await assert.rejects(renderRedirectsFile({ recordUrl, flagsUrl, redirectsUrl }), /missing key\(s\) paymentsLive/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('adds the MCPB route only when its released bytes are checksum-pinned', () => {
  const published = release('1.2.3', {
    assets: [
      ...release('1.2.3').assets,
      { name: 'ContextCake-1.2.3.mcpb', size: 42, browser_download_url: 'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3.mcpb' },
    ],
  })
  const checksums = `${armSums()}${E}  ContextCake-1.2.3.mcpb\n`
  const record = buildAppReleaseRecord(published, checksums)
  assert.equal(record.mcpb?.sha256, E)
  assert.equal(buildAppReleaseRecord(release('1.2.3'), armSums()).mcpb, undefined)

  assert.throws(
    () => buildAppReleaseRecord(published, armSums()),
    /SHA256SUMS is missing ContextCake-1\.2\.3\.mcpb/,
  )
})

test('rejects malformed checksum manifests', () => {
  assert.throws(() => parseChecksums('not a checksum'), /Invalid SHA256SUMS line/)
})

test('syncs one exact published tag and probes every available artifact', async () => {
  const published = twoArchRelease()
  const seen = []
  const fetchImpl = async (url, options = {}) => {
    seen.push([url, options.method ?? 'GET', options.redirect ?? 'follow'])
    if (url.endsWith('/releases/tags/app-v1.2.3')) {
      return new Response(JSON.stringify(published), { status: 200 })
    }
    if (url.endsWith('/SHA256SUMS')) return new Response(twoArchSums(), { status: 200 })
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
  const download = 'https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3'
  assert.deepEqual(seen.map((entry) => entry[0]), [
    'https://api.github.com/repos/ContextCake/context-cake/releases/tags/app-v1.2.3',
    `${download}/SHA256SUMS`,
    `${download}/ContextCake-1.2.3-arm64.dmg`,
    `${download}/ContextCake-1.2.3-arm64-mac.zip`,
    `${download}/ContextCake-1.2.3-x64.dmg`,
    `${download}/ContextCake-1.2.3-x64-mac.zip`,
  ])
  assert.ok(seen.slice(2).every((entry) => entry[1] === 'GET' && entry[2] === 'manual'))
})

test('rejects a release whose advertised Mac artifact is not downloadable', async () => {
  const published = release('1.2.3')
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/tags/app-v1.2.3')) {
      return new Response(JSON.stringify(published), { status: 200 })
    }
    if (url.endsWith('/SHA256SUMS')) return new Response(armSums(), { status: 200 })
    if (url.endsWith('.dmg')) return new Response('missing', { status: 404 })
    throw new Error(`unexpected URL ${url}`)
  }

  await assert.rejects(
    fetchAppReleaseRecord({ tag: 'app-v1.2.3', fetchImpl }),
    /ContextCake-1\.2\.3-arm64\.dmg is not downloadable \(HTTP 404\)/,
  )
})
