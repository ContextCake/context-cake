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

export function parseChecksums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (!match) throw new Error(`Invalid SHA-256 line: ${line}`)
    sums.set(match[2], match[1])
  }
  return sums
}

function unquote(value) {
  const match = /^(['"])(.*)\1$/.exec(value)
  return match ? match[2] : value
}

// electron-builder's update feed (latest-mac.yml, latest-linux.yml) is a small,
// fixed YAML shape: top-level scalars plus a `files:` list of url/sha512/size
// maps. This reads exactly that shape and refuses anything else, so a feed the
// check cannot understand fails the release instead of passing a substring test.
export function parseUpdateFeed(text) {
  const feed = { files: [] }
  let inFiles = false
  let current = null
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const top = /^([A-Za-z]\w*):(?: (.*))?$/.exec(raw)
    const item = /^ {2}- ([A-Za-z]\w*): (.+)$/.exec(raw)
    const property = /^ {4}([A-Za-z]\w*): (.+)$/.exec(raw)
    if (top) {
      current = null
      inFiles = top[1] === 'files' && top[2] === undefined
      if (!inFiles) {
        if (top[2] === undefined) throw new Error(`Unsupported update feed block "${top[1]}" on line ${index + 1}`)
        feed[top[1]] = unquote(top[2])
      }
    } else if (inFiles && item) {
      current = { [item[1]]: unquote(item[2]) }
      feed.files.push(current)
    } else if (inFiles && current && property) {
      current[property[1]] = unquote(property[2])
    } else {
      throw new Error(`Unsupported update feed line ${index + 1}: ${raw}`)
    }
  }
  if (!feed.version) throw new Error('Update feed has no version')
  for (const file of feed.files) {
    if (!file.url || !file.sha512 || !/^\d+$/.test(file.size ?? '')) {
      throw new Error(`Update feed entry ${file.url ?? '(no url)'} needs url, sha512, and size`)
    }
    file.size = Number(file.size)
  }
  return feed
}

// Checks a release directory against the table and throws one error listing
// every problem.
//   stage 'build': every row's installer, update file, and feed exist; each
//     feed is for this version and lists its rows' update file with the sha512
//     and size of the bytes on disk.
//   stage 'publish': also the ping assets, and a SHA256SUMS whose lines match
//     the bytes on disk.
//   digests (either stage): SHA-256 values recorded where the files were built
//     (a Map, or SHA256SUMS-format text). Every checksummed file must be listed
//     and match, so bytes that changed between jobs stop the release.
// A release publishes only after the publish stage passes for every row
// (distribution spec §5).
export function verifyReleaseDirectory({ dir, version, stage = 'build', os, id, digests } = {}) {
  releaseVersion(version)
  if (!['build', 'publish'].includes(stage)) throw new Error(`Unknown release check stage "${stage}"`)
  const problems = []
  const files = []
  const feeds = new Map()
  const hashes = new Map()
  const present = (name) => {
    const file = path.join(dir, name)
    const ok = fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0
    return ok ? file : null
  }
  const hash = (file, algorithm, encoding) => {
    const key = `${algorithm}:${file}`
    if (!hashes.has(key)) hashes.set(key, createHash(algorithm).update(fs.readFileSync(file)).digest(encoding))
    return hashes.get(key)
  }
  const note = (file) => { if (!files.includes(file)) files.push(file) }
  const rows = rowsFor({ os, id })

  for (const row of rows) {
    const wanted = [row.installerName(version), row.updaterName(version), row.feed]
    if (stage === 'publish') wanted.push(row.pingAsset)
    for (const name of wanted.filter(Boolean)) {
      const file = present(name)
      if (file) note(file)
      else problems.push(`${row.id}: missing ${name}`)
    }

    const feedFile = present(row.feed)
    if (!feedFile) continue
    if (!feeds.has(feedFile)) {
      try {
        feeds.set(feedFile, parseUpdateFeed(fs.readFileSync(feedFile, 'utf8')))
      } catch (error) {
        feeds.set(feedFile, error)
      }
    }
    const feed = feeds.get(feedFile)
    if (feed instanceof Error) {
      problems.push(`${row.id}: ${row.feed} cannot be read: ${feed.message}`)
      continue
    }
    if (feed.version !== version) problems.push(`${row.id}: ${row.feed} is for version ${feed.version}, not ${version}`)
    const updateName = row.updaterName(version) ?? row.installerName(version)
    const entry = feed.files.find((candidate) => candidate.url === updateName)
    const updateFile = present(updateName)
    if (!entry) {
      problems.push(`${row.id}: ${row.feed} does not list ${updateName}`)
    } else if (updateFile) {
      if (entry.size !== fs.statSync(updateFile).size) problems.push(`${row.id}: ${row.feed} size for ${updateName} does not match the file`)
      if (entry.sha512 !== hash(updateFile, 'sha512', 'base64')) problems.push(`${row.id}: ${row.feed} sha512 for ${updateName} does not match the file`)
    }
  }

  const checksummed = releaseFileNames({ version, kind: 'checksummed', os, id })
  const compare = (label, sums) => {
    for (const name of checksummed) {
      const file = present(name)
      if (!file) continue
      if (!sums.has(name)) problems.push(`${label} has no line for ${name}`)
      else if (sums.get(name) !== hash(file, 'sha256', 'hex')) problems.push(`${label} does not match ${name}`)
    }
  }

  if (digests !== undefined) {
    try {
      compare('build digests', digests instanceof Map ? digests : parseChecksums(String(digests)))
    } catch (error) {
      problems.push(`build digests cannot be read: ${error.message}`)
    }
  }

  if (stage === 'publish') {
    const sumsFile = present('SHA256SUMS')
    if (!sumsFile) problems.push('missing SHA256SUMS')
    else compare('SHA256SUMS', parseChecksums(fs.readFileSync(sumsFile, 'utf8')))
  }

  if (problems.length) {
    throw new Error(`Release ${version} is incomplete (${stage} check):\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }
  return files
}

const USAGE = `Usage:
  node scripts/release-platforms.mjs --list ids
  node scripts/release-platforms.mjs --list <${Object.keys(KINDS).join('|')}> --version X.Y.Z [--os mac | --id mac-x64]
  node scripts/release-platforms.mjs --check DIR --version X.Y.Z [--stage build|publish] [--digests FILE] [--os mac | --id mac-x64]`

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    const key = { '--list': 'list', '--check': 'check', '--version': 'version', '--stage': 'stage', '--os': 'os', '--id': 'id', '--digests': 'digests' }[flag]
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
    const digests = options.digests === undefined ? undefined : fs.readFileSync(options.digests, 'utf8')
    const files = verifyReleaseDirectory({ dir: options.check, version: options.version, stage: options.stage, os: options.os, id: options.id, digests })
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
