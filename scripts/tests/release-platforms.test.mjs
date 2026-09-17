import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RELEASE_PLATFORMS,
  parseUpdateFeed,
  platformById,
  releaseFileNames,
  verifyReleaseDirectory,
} from '../release-platforms.mjs'
import { installMetricAsset } from '../../apps/desktop/src/main/install-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/release-platforms.mjs')
const version = '1.2.3'
const sha = (text) => createHash('sha256').update(text).digest('hex')
const sha512 = (text) => createHash('sha512').update(text).digest('base64')
const bytesOf = (name) => `bytes of ${name}`

// The shape electron-builder writes, including the legacy top-level path.
function feedText({ feedVersion = version, rows = RELEASE_PLATFORMS, entry = (name) => ({ sha512: sha512(bytesOf(name)), size: Buffer.byteLength(bytesOf(name)) }) } = {}) {
  const files = rows.map((row) => {
    const name = row.updaterName(version)
    const { sha512: digest, size } = entry(name)
    return `  - url: ${name}\n    sha512: ${digest}\n    size: ${size}\n`
  }).join('')
  return `version: ${feedVersion}\nfiles:\n${files}path: ${rows[0].updaterName(version)}\nsha512: x\nreleaseDate: '2026-09-17T03:51:20.923Z'\n`
}

test('every row carries the full shape and names nothing twice', () => {
  assert.deepEqual(RELEASE_PLATFORMS.map((row) => row.id), ['mac-arm64', 'mac-x64'])
  for (const row of RELEASE_PLATFORMS) {
    for (const key of ['id', 'os', 'nodePlatform', 'arch', 'osLabel', 'label', 'platformName', 'feed', 'updates', 'downloadPath', 'pingAsset']) {
      assert.equal(typeof row[key], 'string', `${row.id}.${key}`)
    }
    assert.equal(typeof row.installerName, 'function')
    assert.equal(typeof row.updaterName, 'function')
    assert.ok(Array.isArray(row.downloadAliases))
    assert.ok(Object.isFrozen(row))
    assert.equal(row.downloadPath, `/download/${row.id}`)
    assert.equal(row.pingAsset, `install-ping-${row.id}.txt`)
    assert.throws(() => row.installerName('latest'), /X\.Y\.Z/)
  }
  const names = RELEASE_PLATFORMS.flatMap((row) => [
    row.installerName(version), row.updaterName(version), row.downloadPath, ...row.downloadAliases, row.pingAsset,
  ]).filter(Boolean)
  assert.equal(new Set(names).size, names.length)
})

test('mac rows keep the published arm64 names and give Intel its own arch suffix', () => {
  const arm = platformById('mac-arm64')
  const intel = platformById('mac-x64')
  assert.equal(arm.installerName(version), 'ContextCake-1.2.3-arm64.dmg')
  assert.equal(arm.updaterName(version), 'ContextCake-1.2.3-arm64-mac.zip')
  assert.equal(intel.installerName(version), 'ContextCake-1.2.3-x64.dmg')
  assert.equal(intel.updaterName(version), 'ContextCake-1.2.3-x64-mac.zip')
  // electron-updater picks the zip whose name contains "arm64" on Apple
  // silicon and excludes every such zip on Intel. One stray "arm64" in an
  // Intel name would hide its update from every Intel Mac.
  assert.doesNotMatch(intel.updaterName(version), /arm64/)
  assert.equal(arm.feed, intel.feed)
  // Existing links keep working.
  assert.deepEqual(arm.downloadAliases, ['/download/mac'])
  assert.equal(arm.legacyPingAsset, 'install-ping.txt')
  assert.equal(platformById('nope'), undefined)
})

test('file lists dedupe the shared feed and filter by OS', () => {
  assert.deepEqual(releaseFileNames({ version, kind: 'installers' }), ['ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-x64.dmg'])
  assert.deepEqual(releaseFileNames({ version, kind: 'feeds' }), ['latest-mac.yml'])
  assert.deepEqual(releaseFileNames({ version, kind: 'pings' }), ['install-ping-mac-arm64.txt', 'install-ping-mac-x64.txt'])
  assert.deepEqual(releaseFileNames({ version, kind: 'checksummed' }), [
    'ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-arm64-mac.zip', 'ContextCake-1.2.3-x64.dmg', 'ContextCake-1.2.3-x64-mac.zip',
  ])
  assert.deepEqual(releaseFileNames({ version, kind: 'updaters', id: 'mac-x64' }), ['ContextCake-1.2.3-x64-mac.zip'])
  // A filter that matches nothing is a typo in a workflow, not an empty list.
  assert.throws(() => releaseFileNames({ version, kind: 'installers', os: 'solaris' }), /No release platform row matches os=solaris/)
  assert.throws(() => releaseFileNames({ version, kind: 'everything' }), /Unknown release file kind/)
})

test('CLI lists names for workflow globs, one per line', () => {
  const out = execFileSync(process.execPath, [script, '--list', 'updaters', '--version', version], { encoding: 'utf8' })
  assert.equal(out, 'ContextCake-1.2.3-arm64-mac.zip\nContextCake-1.2.3-x64-mac.zip\n')
  const ids = execFileSync(process.execPath, [script, '--list', 'ids'], { encoding: 'utf8' })
  assert.equal(ids, 'mac-arm64\nmac-x64\n')
  const intel = execFileSync(process.execPath, [script, '--list', 'installers', '--version', version, '--id', 'mac-x64'], { encoding: 'utf8' })
  assert.equal(intel, 'ContextCake-1.2.3-x64.dmg\n')
  const bad = spawnSync(process.execPath, [script, '--list', 'installers'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /--version/)
})

async function writeBuild(dir, { skip = [], feed } = {}) {
  for (const row of RELEASE_PLATFORMS) {
    for (const name of [row.installerName(version), row.updaterName(version)]) {
      if (!skip.includes(name)) await writeFile(path.join(dir, name), bytesOf(name))
    }
  }
  await writeFile(path.join(dir, 'latest-mac.yml'), feed ?? feedText())
}

test('the feed parser reads electron-builder output and refuses other shapes', () => {
  const feed = parseUpdateFeed(feedText())
  assert.equal(feed.version, version)
  assert.equal(feed.releaseDate, '2026-09-17T03:51:20.923Z')
  assert.deepEqual(feed.files.map((file) => file.url), ['ContextCake-1.2.3-arm64-mac.zip', 'ContextCake-1.2.3-x64-mac.zip'])
  assert.equal(typeof feed.files[0].size, 'number')
  assert.throws(() => parseUpdateFeed('files:\n  - url: a.zip\n    sha512: x\n    size: 1\n'), /no version/)
  assert.throws(() => parseUpdateFeed(`version: ${version}\nfiles:\n  - url: a.zip\n    sha512: x\n`), /needs url, sha512, and size/)
  assert.throws(() => parseUpdateFeed(`version: ${version}\nreleaseNotes: |\n  hello\n`), /Unsupported update feed/)
  // A url that merely contains the name is not the name.
  const lookalike = feedText().replaceAll('url: ContextCake-1.2.3-x64-mac.zip', 'url: old/ContextCake-1.2.3-x64-mac.zip.bak')
  assert.equal(parseUpdateFeed(lookalike).files.some((file) => file.url === 'ContextCake-1.2.3-x64-mac.zip'), false)
})

test('a build directory passes only when every row is present and named by its feed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir)
    assert.deepEqual(verifyReleaseDirectory({ dir, version, stage: 'build' }).map((file) => path.basename(file)), [
      'ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-arm64-mac.zip', 'latest-mac.yml',
      'ContextCake-1.2.3-x64.dmg', 'ContextCake-1.2.3-x64-mac.zip',
    ])

    await rm(path.join(dir, 'ContextCake-1.2.3-x64.dmg'))
    await rm(path.join(dir, 'ContextCake-1.2.3-arm64-mac.zip'))
    assert.throws(
      () => verifyReleaseDirectory({ dir, version, stage: 'build' }),
      (error) => /mac-arm64: missing ContextCake-1\.2\.3-arm64-mac\.zip/.test(error.message)
        && /mac-x64: missing ContextCake-1\.2\.3-x64\.dmg/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a feed that omits one architecture fails the build check', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir, { feed: feedText({ rows: [platformById('mac-arm64')] }) })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /mac-x64: latest-mac\.yml does not list ContextCake-1\.2\.3-x64-mac\.zip/)
    // Filtering to one OS never excuses a row of that OS.
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build', os: 'mac' }), /mac-x64/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a feed whose version, sha512, or size disagrees with the bytes fails the build check', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir, { feed: feedText({ feedVersion: '1.2.2' }) })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /latest-mac\.yml is for version 1\.2\.2, not 1\.2\.3/)

    await writeBuild(dir, { feed: feedText({ entry: (name) => ({ sha512: sha512('other bytes'), size: Buffer.byteLength(bytesOf(name)) }) }) })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /mac-arm64: latest-mac\.yml sha512 for ContextCake-1\.2\.3-arm64-mac\.zip does not match the file/)

    await writeBuild(dir, { feed: feedText({ entry: (name) => ({ sha512: sha512(bytesOf(name)), size: 7 }) }) })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /mac-x64: latest-mac\.yml size for ContextCake-1\.2\.3-x64-mac\.zip does not match the file/)

    await writeBuild(dir, { feed: 'version: 1.2.3\nfiles: []\n' })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /latest-mac\.yml cannot be read/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('build digests must list every checksummed file and match its bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir)
    const names = releaseFileNames({ version, kind: 'checksummed' })
    const digests = names.map((name) => `${sha(bytesOf(name))}  ${name}`).join('\n')
    verifyReleaseDirectory({ dir, version, stage: 'build', digests })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build', digests: digests.split('\n').slice(1).join('\n') }), /build digests has no line for ContextCake-1\.2\.3-arm64\.dmg/)

    // Bytes that changed after the build job hashed them.
    await writeFile(path.join(dir, 'ContextCake-1.2.3-x64.dmg'), 'tampered')
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build', digests }), /build digests does not match ContextCake-1\.2\.3-x64\.dmg/)
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build', digests: 'not a digest' }), /build digests cannot be read/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the publish stage also requires ping assets and matching SHA256SUMS lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir)
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'publish' }), /missing install-ping-mac-arm64\.txt[\s\S]*missing SHA256SUMS/)

    for (const row of RELEASE_PLATFORMS) await writeFile(path.join(dir, row.pingAsset), 'ping')
    const names = releaseFileNames({ version, kind: 'checksummed' })
    const lines = names.map((name) => `${sha(bytesOf(name))}  ${name}`)
    await writeFile(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
    verifyReleaseDirectory({ dir, version, stage: 'publish' })

    await writeFile(path.join(dir, 'SHA256SUMS'), `${lines.slice(1).join('\n')}\n`)
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'publish' }), /SHA256SUMS has no line for ContextCake-1\.2\.3-arm64\.dmg/)

    await writeFile(path.join(dir, 'SHA256SUMS'), `${[`${'0'.repeat(64)}  ${names[0]}`, ...lines.slice(1)].join('\n')}\n`)
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'publish' }), /SHA256SUMS does not match ContextCake-1\.2\.3-arm64\.dmg/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI check exits non-zero and names the missing row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir, { skip: ['ContextCake-1.2.3-x64-mac.zip'] })
    const result = spawnSync(process.execPath, [script, '--check', dir, '--version', version, '--stage', 'build'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /mac-x64: missing ContextCake-1\.2\.3-x64-mac\.zip/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function yamlBlock(text, key) {
  const match = new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)*)`, 'm').exec(text)
  assert.ok(match, `electron-builder.yml has no ${key}: block`)
  return match[1]
}

function expand(pattern, row, ext) {
  return pattern
    .replaceAll('${productName}', 'ContextCake')
    .replaceAll('${version}', version)
    .replaceAll('${arch}', row.arch)
    .replaceAll('${ext}', ext)
}

test('electron-builder names every mac artifact the way the table does', async () => {
  const config = await readFile(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
  const mac = yamlBlock(config, 'mac')
  const dmg = yamlBlock(config, 'dmg')
  const zipPattern = /^ {2}artifactName: "([^"]+)"$/m.exec(mac)?.[1]
  const dmgPattern = /^ {2}artifactName: "([^"]+)"$/m.exec(dmg)?.[1]
  assert.ok(zipPattern && dmgPattern, 'mac and dmg must both set artifactName explicitly')
  const macRows = RELEASE_PLATFORMS.filter((row) => row.os === 'mac')
  for (const row of macRows) {
    assert.equal(expand(dmgPattern, row, 'dmg'), row.installerName(version))
    assert.equal(expand(zipPattern, row, 'zip'), row.updaterName(version))
  }
  const arches = [...mac.matchAll(/arch: \[([^\]]+)\]/g)].map((match) => match[1].split(',').map((arch) => arch.trim()))
  assert.equal(arches.length, 2, 'dmg and zip targets')
  for (const list of arches) assert.deepEqual(list, macRows.map((row) => row.arch))

  const pkg = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  assert.doesNotMatch(pkg.scripts.dist, /--arm64|--x64/, 'dist builds every arch the config lists')
  assert.doesNotMatch(pkg.scripts.pack, /--arm64|--x64/, 'pack builds the host arch')
  assert.match(pkg.scripts.pack, /--dir/)
})

test('the app asks for the ping asset of the row it was built as', () => {
  for (const row of RELEASE_PLATFORMS) {
    assert.equal(installMetricAsset({ platform: row.nodePlatform, arch: row.arch, packageType: row.packageType }), row.pingAsset)
  }
})
