#!/usr/bin/env node
// The release platform table: the one place that names a downloadable app
// artifact (specs/contextcake-distribution/design.md §11.1). The release
// workflow, electron-builder's artifactName parity test, the channel artifact
// builder, the site release sync, the surface verifier, and the metrics report
// all read these rows. Never rebuild an artifact name anywhere else; add a
// platform by adding a row.
//
// Row fields:
//   id              stable key; the site record, download path, and ping asset use it
//   os, nodePlatform  'mac' | 'linux' and the matching process.platform value
//   arch            process.arch of the build ('arm64', 'x64')
//   packageType     optional; set when one OS/arch ships more than one package (e.g. 'deb')
//   osLabel, label  "Mac" + "Apple silicon": group heading and choice within it
//   platformName    stands alone in a sentence: "Intel Mac"
//   installerName   (version) => the file a person downloads
//   updaterName     (version) => the file the in-app updater downloads, or null
//   feed            the electron-updater feed that must list this row's update file
//   updates         'self' (the app updates itself) | 'notify' (it only links)
//   downloadPath    the site route that redirects to installerName
//   downloadAliases older site routes that also redirect here
//   pingAsset       the content-free first-launch counter this row's app fetches
//   legacyPingAsset the pre-table counter this row inherits in old releases
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = /^\d+\.\d+\.\d+$/

function releaseVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('Release artifact names require a stable X.Y.Z version.')
  }
  return version
}

function macRow({ arch, label, platformName, downloadAliases = [], legacyPingAsset = null }) {
  const id = `mac-${arch}`
  return Object.freeze({
    id,
    os: 'mac',
    nodePlatform: 'darwin',
    arch,
    osLabel: 'Mac',
    label,
    platformName,
    installerName: (version) => `ContextCake-${releaseVersion(version)}-${arch}.dmg`,
    updaterName: (version) => `ContextCake-${releaseVersion(version)}-${arch}-mac.zip`,
    feed: 'latest-mac.yml',
    updates: 'self',
    downloadPath: `/download/${id}`,
    downloadAliases: Object.freeze(downloadAliases),
    pingAsset: `install-ping-${id}.txt`,
    legacyPingAsset,
  })
}

export const RELEASE_PLATFORMS = Object.freeze([
  macRow({
    arch: 'arm64',
    label: 'Apple silicon',
    platformName: 'Apple silicon Mac',
    downloadAliases: ['/download/mac'],
    // Every release before the table shipped arm64 only, with one counter.
    legacyPingAsset: 'install-ping.txt',
  }),
  macRow({ arch: 'x64', label: 'Intel', platformName: 'Intel Mac' }),
  // The .deb updates by notification only: the app links the download and
  // never installs it (design §11.4). electron-builder names a deb's x64 arch
  // "amd64", as Debian does. latest-linux.yml lists the .deb itself, so the
  // feed check looks for the installer.
  Object.freeze({
    id: 'linux-x64-deb',
    os: 'linux',
    nodePlatform: 'linux',
    arch: 'x64',
    packageType: 'deb',
    osLabel: 'Linux',
    label: 'Debian and Ubuntu',
    platformName: 'Linux',
    installerName: (version) => `ContextCake-${releaseVersion(version)}-amd64.deb`,
    updaterName: () => null,
    feed: 'latest-linux.yml',
    updates: 'notify',
    downloadPath: '/download/linux-x64-deb',
    downloadAliases: Object.freeze(['/download/linux']),
    pingAsset: 'install-ping-linux-x64-deb.txt',
    legacyPingAsset: null,
  }),
])

export function platformById(id) {
  return RELEASE_PLATFORMS.find((row) => row.id === id)
}

// Optional filters: every row of one OS, or one row by id.
function rowsFor({ os, id } = {}) {
  const rows = RELEASE_PLATFORMS.filter((row) => (!os || row.os === os) && (!id || row.id === id))
  if (!rows.length) throw new Error(`No release platform row matches${os ? ` os=${os}` : ''}${id ? ` id=${id}` : ''}.`)
  return rows
}

const KINDS = {
  installers: (row, version) => [row.installerName(version)],
  updaters: (row, version) => [row.updaterName(version)],
  feeds: (row) => [row.feed],
  pings: (row) => [row.pingAsset],
  // Every file whose bytes a person or the updater downloads gets a SHA256SUMS line.
  checksummed: (row, version) => [row.installerName(version), row.updaterName(version)],
}

export function releaseFileNames({ version, kind, os, id } = {}) {
  const pick = KINDS[kind]
  if (!pick) throw new Error(`Unknown release file kind "${kind}". Known: ${Object.keys(KINDS).join(', ')}`)
  const names = rowsFor({ os, id }).flatMap((row) => pick(row, version)).filter(Boolean)
  return [...new Set(names)]
}

function readChecksums(file) {
  const sums = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match) sums.set(match[2], match[1])
  }
  return sums
}

// Checks a release directory against the table and throws one error listing
// every problem. stage 'build': installers, update files, and feeds exist, and
// each feed names its rows' update files. stage 'publish' adds the ping assets
// and a SHA256SUMS whose lines match the bytes on disk. A release publishes
// only after the publish stage passes for every row (distribution spec §5).
export function verifyReleaseDirectory({ dir, version, stage = 'build', os, id } = {}) {
  releaseVersion(version)
  if (!['build', 'publish'].includes(stage)) throw new Error(`Unknown release check stage "${stage}"`)
  const problems = []
  const files = []
  const feeds = new Map()
  const present = (name) => {
    const file = path.join(dir, name)
    const ok = fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0
    return ok ? file : null
  }
  const note = (file) => { if (!files.includes(file)) files.push(file) }

  for (const row of rowsFor({ os, id })) {
    const wanted = [row.installerName(version), row.updaterName(version), row.feed]
    if (stage === 'publish') wanted.push(row.pingAsset)
    for (const name of wanted.filter(Boolean)) {
      const file = present(name)
      if (file) note(file)
      else problems.push(`${row.id}: missing ${name}`)
    }
    const feedFile = present(row.feed)
    if (feedFile) {
      if (!feeds.has(feedFile)) feeds.set(feedFile, fs.readFileSync(feedFile, 'utf8'))
      const updateFile = row.updaterName(version) ?? row.installerName(version)
      if (!feeds.get(feedFile).includes(updateFile)) {
        problems.push(`${row.id}: ${row.feed} does not list ${updateFile}`)
      }
    }
  }

  if (stage === 'publish') {
    const sumsFile = present('SHA256SUMS')
    if (!sumsFile) {
      problems.push('missing SHA256SUMS')
    } else {
      const sums = readChecksums(sumsFile)
      for (const name of releaseFileNames({ version, kind: 'checksummed', os, id })) {
        const file = present(name)
        if (!file) continue
        if (!sums.has(name)) problems.push(`SHA256SUMS has no line for ${name}`)
        else if (sums.get(name) !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) {
          problems.push(`SHA256SUMS does not match ${name}`)
        }
      }
    }
  }

  if (problems.length) {
    throw new Error(`Release ${version} is incomplete (${stage} check):\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }
  return files
}

const USAGE = `Usage:
  node scripts/release-platforms.mjs --list ids
  node scripts/release-platforms.mjs --list <${Object.keys(KINDS).join('|')}> --version X.Y.Z [--os mac | --id mac-x64]
  node scripts/release-platforms.mjs --check DIR --version X.Y.Z [--stage build|publish] [--os mac | --id mac-x64]`

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    const key = { '--list': 'list', '--check': 'check', '--version': 'version', '--stage': 'stage', '--os': 'os', '--id': 'id' }[flag]
    if (!key || !value || options[key] !== undefined) throw new Error(USAGE)
    options[key] = value
  }
  if (Boolean(options.list) === Boolean(options.check)) throw new Error(USAGE)
  if (options.list !== 'ids' && !options.version) throw new Error(`--version is required.\n${USAGE}`)
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list === 'ids') {
    process.stdout.write(rowsFor(options).map((row) => `${row.id}\n`).join(''))
  } else if (options.list) {
    const names = releaseFileNames({ version: options.version, kind: options.list, os: options.os, id: options.id })
    process.stdout.write(names.map((name) => `${name}\n`).join(''))
  } else {
    const files = verifyReleaseDirectory({ dir: options.check, version: options.version, stage: options.stage, os: options.os, id: options.id })
    console.error(`release ${options.version}: ${files.length} file(s) present for ${rowsFor(options).map((row) => row.id).join(', ')}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error?.message ?? error)
    process.exitCode = 1
  }
}
