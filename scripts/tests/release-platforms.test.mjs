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
  platformById,
  releaseFileNames,
  verifyReleaseDirectory,
} from '../release-platforms.mjs'
import { installMetricAsset } from '../../apps/desktop/src/main/install-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/release-platforms.mjs')
const version = '1.2.3'
const sha = (text) => createHash('sha256').update(text).digest('hex')

test('every row carries the full shape and names nothing twice', () => {
  assert.deepEqual(RELEASE_PLATFORMS.map((row) => row.id), ['mac-arm64', 'mac-x64', 'linux-x64-deb'])
  for (const row of RELEASE_PLATFORMS) {
    for (const key of ['id', 'os', 'nodePlatform', 'arch', 'osLabel', 'label', 'platformName', 'feed', 'updates', 'downloadPath', 'pingAsset']) {
      assert.equal(typeof row[key], 'string', `${row.id}.${key}`)
    }
    assert.equal(typeof row.installerName, 'function')
    assert.equal(typeof row.updaterName, 'function')
    assert.ok(['self', 'notify'].includes(row.updates), `${row.id}.updates`)
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

test('the Linux row ships a .deb that only notifies and has no update file', () => {
  const deb = platformById('linux-x64-deb')
  assert.equal(deb.nodePlatform, 'linux')
  assert.equal(deb.packageType, 'deb')
  assert.equal(deb.installerName(version), 'ContextCake-1.2.3-amd64.deb')
  assert.equal(deb.updaterName(version), null)
  assert.equal(deb.feed, 'latest-linux.yml')
  assert.equal(deb.updates, 'notify')
  assert.deepEqual(deb.downloadAliases, ['/download/linux'])
  // The Mac rows update themselves; only a package-managed install notifies.
  assert.deepEqual(RELEASE_PLATFORMS.filter((row) => row.updates === 'notify').map((row) => row.id), ['linux-x64-deb'])
})

test('file lists dedupe the shared feed and filter by OS', () => {
  assert.deepEqual(releaseFileNames({ version, kind: 'installers' }), ['ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-x64.dmg', 'ContextCake-1.2.3-amd64.deb'])
  assert.deepEqual(releaseFileNames({ version, kind: 'installers', os: 'mac' }), ['ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-x64.dmg'])
  assert.deepEqual(releaseFileNames({ version, kind: 'feeds' }), ['latest-mac.yml', 'latest-linux.yml'])
  assert.deepEqual(releaseFileNames({ version, kind: 'pings' }), ['install-ping-mac-arm64.txt', 'install-ping-mac-x64.txt', 'install-ping-linux-x64-deb.txt'])
  assert.deepEqual(releaseFileNames({ version, kind: 'checksummed' }), [
    'ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-arm64-mac.zip', 'ContextCake-1.2.3-x64.dmg', 'ContextCake-1.2.3-x64-mac.zip',
    'ContextCake-1.2.3-amd64.deb',
  ])
  assert.deepEqual(releaseFileNames({ version, kind: 'updaters', id: 'mac-x64' }), ['ContextCake-1.2.3-x64-mac.zip'])
  // A row with no update file contributes nothing, never an empty line.
  assert.deepEqual(releaseFileNames({ version, kind: 'updaters', os: 'linux' }), [])
  // A filter that matches nothing is a typo in a workflow, not an empty list.
  assert.throws(() => releaseFileNames({ version, kind: 'installers', os: 'solaris' }), /No release platform row matches os=solaris/)
  assert.throws(() => releaseFileNames({ version, kind: 'everything' }), /Unknown release file kind/)
})

test('CLI lists names for workflow globs, one per line', () => {
  const out = execFileSync(process.execPath, [script, '--list', 'updaters', '--version', version], { encoding: 'utf8' })
  assert.equal(out, 'ContextCake-1.2.3-arm64-mac.zip\nContextCake-1.2.3-x64-mac.zip\n')
  const ids = execFileSync(process.execPath, [script, '--list', 'ids'], { encoding: 'utf8' })
  assert.equal(ids, 'mac-arm64\nmac-x64\nlinux-x64-deb\n')
  const linux = execFileSync(process.execPath, [script, '--list', 'installers', '--version', version, '--os', 'linux'], { encoding: 'utf8' })
  assert.equal(linux, 'ContextCake-1.2.3-amd64.deb\n')
  const intel = execFileSync(process.execPath, [script, '--list', 'installers', '--version', version, '--id', 'mac-x64'], { encoding: 'utf8' })
  assert.equal(intel, 'ContextCake-1.2.3-x64.dmg\n')
  const bad = spawnSync(process.execPath, [script, '--list', 'installers'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /--version/)
})

async function writeBuild(dir, { skip = [], feed, linuxFeed } = {}) {
  for (const row of RELEASE_PLATFORMS) {
    for (const name of [row.installerName(version), row.updaterName(version)].filter(Boolean)) {
      if (!skip.includes(name)) await writeFile(path.join(dir, name), `bytes of ${name}`)
    }
  }
  const zips = RELEASE_PLATFORMS.filter((row) => row.os === 'mac').map((row) => `  - url: ${row.updaterName(version)}\n`).join('')
  await writeFile(path.join(dir, 'latest-mac.yml'), feed ?? `version: ${version}\nfiles:\n${zips}`)
  await writeFile(path.join(dir, 'latest-linux.yml'), linuxFeed ?? `version: ${version}\nfiles:\n  - url: ${platformById('linux-x64-deb').installerName(version)}\n`)
}

test('a build directory passes only when every row is present and named by its feed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir)
    assert.deepEqual(verifyReleaseDirectory({ dir, version, stage: 'build' }).map((file) => path.basename(file)), [
      'ContextCake-1.2.3-arm64.dmg', 'ContextCake-1.2.3-arm64-mac.zip', 'latest-mac.yml',
      'ContextCake-1.2.3-x64.dmg', 'ContextCake-1.2.3-x64-mac.zip',
      'ContextCake-1.2.3-amd64.deb', 'latest-linux.yml',
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
    await writeBuild(dir, { feed: `version: ${version}\nfiles:\n  - url: ContextCake-1.2.3-arm64-mac.zip\n` })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /mac-x64: latest-mac\.yml does not list ContextCake-1\.2\.3-x64-mac\.zip/)
    // Filtering to one OS never excuses a row of that OS.
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build', os: 'mac' }), /mac-x64/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Linux row passes when its feed names the .deb, and fails without the feed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-release-platforms-'))
  try {
    await writeBuild(dir, { linuxFeed: `version: ${version}\nfiles:\n  - url: something-else.deb\n` })
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /linux-x64-deb: latest-linux\.yml does not list ContextCake-1\.2\.3-amd64\.deb/)
    // A Mac-only check never looks at the Linux feed.
    verifyReleaseDirectory({ dir, version, stage: 'build', os: 'mac' })
    await rm(path.join(dir, 'latest-linux.yml'))
    assert.throws(() => verifyReleaseDirectory({ dir, version, stage: 'build' }), /linux-x64-deb: missing latest-linux\.yml/)
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
    const lines = names.map((name) => `${sha(`bytes of ${name}`)}  ${name}`)
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

// electron-builder's ${arch} macro is Debian's name inside a .deb file name
// (builder-util getArtifactArchName).
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }

test('electron-builder names the Linux .deb the way the table does', async () => {
  const config = await readFile(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
  const linux = yamlBlock(config, 'linux')
  const pattern = /^ {2}artifactName: "([^"]+)"$/m.exec(linux)?.[1]
  assert.ok(pattern, 'linux must set artifactName explicitly')
  const linuxRows = RELEASE_PLATFORMS.filter((row) => row.os === 'linux')
  for (const row of linuxRows) {
    assert.equal(expand(pattern, { ...row, arch: DEB_ARCH[row.arch] }, row.packageType), row.installerName(version))
  }
  assert.match(linux, /- target: deb\n\s+arch: \[x64\]/)
  assert.match(linux, /syncDesktopName: true/)
  const pkg = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  assert.equal(pkg.homepage, 'https://contextcake.com')
  assert.equal(typeof pkg.desktopName, 'string')
  // The deb maintainer comes from the build environment, never from the repo.
  assert.equal(pkg.author, undefined)
  assert.doesNotMatch(config, /maintainer:/)
  assert.match(pkg.scripts['dist:linux'], /scripts\/dist-linux\.mjs/)
})

test('the app asks for the ping asset of the row it was built as', () => {
  for (const row of RELEASE_PLATFORMS) {
    assert.equal(installMetricAsset({ platform: row.nodePlatform, arch: row.arch, packageType: row.packageType }), row.pingAsset)
  }
})
