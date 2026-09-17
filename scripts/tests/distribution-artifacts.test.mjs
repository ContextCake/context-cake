import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertHomebrewCask,
  buildMcpb,
  buildNpmPackage,
  mcpbName,
  NPM_POLICY_FIXTURES,
  npmTarballName,
  releaseAssetNames,
  renderHomebrewCask,
  renderMcpManifest,
  renderMcpRegistryRecord,
  sha256,
  verifyUploadedAssets,
  writeReleaseChannelArtifacts,
} from '../distribution-artifacts.mjs'
import { RELEASE_PLATFORMS } from '../release-platforms.mjs'

const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const version = rootPackage.version
const escapedVersion = version.replaceAll('.', '\\.')
const digest = 'a'.repeat(64)

test('Homebrew cask pins each Mac architecture to its own DMG digest in the standard arch form', () => {
  const digests = { 'mac-arm64': digest, 'mac-x64': 'b'.repeat(64) }
  const cask = renderHomebrewCask({ version, digests })
  assert.match(cask, /^  arch arm: "arm64", intel: "x64"$/m)
  assert.match(cask, /^  sha256 arm:   "a{64}",\n {9}intel: "b{64}"$/m)
  assert.match(cask, /^  url "https:\/\/github\.com\/ContextCake\/context-cake\/releases\/download\/app-v#\{version\}\/ContextCake-#\{version\}-#\{arch\}\.dmg"$/m)
  assert.equal((cask.match(/^\s*url /gm) ?? []).length, 1)
  assert.doesNotMatch(cask, /on_arm|on_intel/)
  assert.match(cask, /auto_updates true/)
  assert.match(cask, /binary "#\{appdir\}\/ContextCake\.app\/Contents\/Resources\/bin\/contextcake"/)
  assert.doesNotMatch(cask, /zap /)
  assertHomebrewCask(cask, { version, digests })
  assert.throws(() => assertHomebrewCask(cask.replace(version, '9.9.9'), { version, digests }), /does not match/)
  assert.throws(() => assertHomebrewCask(cask, { version, digests: { ...digests, 'mac-x64': 'c'.repeat(64) } }), /does not match/)
  assert.throws(() => renderHomebrewCask({ version, digests: { 'mac-arm64': digest } }), /mac-x64/)
})

test('MCPB metadata requires an explicit manifest and leaves anonymous activation off by default', () => {
  const manifest = renderMcpManifest(version)
  assert.equal(manifest.manifest_version, '0.3')
  // win32 is listed because the windows-latest CI job runs the unit group and
  // the eval. Drop it if that job goes away.
  assert.deepEqual(manifest.compatibility.platforms, ['darwin', 'win32'])
  assert.equal(manifest.server.mcp_config.args.at(-1), '${user_config.manifest_path}')
  assert.equal(manifest.user_config.anonymous_metrics.default, false)
  assert.match(manifest.user_config.anonymous_metrics.description, /No files, paths, prompts, account data, device ID, or request body/)
  const registry = renderMcpRegistryRecord({ version, fileSha256: digest })
  assert.equal(registry.packages[0].registryType, 'mcpb')
  assert.match(registry.packages[0].identifier, new RegExp(`ContextCake-${escapedVersion}\\.mcpb$`))
  assert.equal(registry.packages[0].fileSha256, digest)
})

test('MCPB bundle has a root manifest, engine code, and no node_modules payload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-mcpb-test-'))
  try {
    const result = await buildMcpb({ version, outFile: path.join(dir, mcpbName(version)) })
    assert.equal(result.sha256, sha256(await readFile(result.file)))
    const files = execFileSync('unzip', ['-Z1', result.file], { encoding: 'utf8' }).split('\n')
    assert.ok(files.includes('manifest.json'))
    assert.ok(files.includes('server/index.mjs'))
    assert.ok(files.includes('engine/mcp-server.mjs'))
    assert.ok(files.every((file) => !file.startsWith('node_modules/')))
    const entry = execFileSync('unzip', ['-p', result.file, 'server/index.mjs'], { encoding: 'utf8' })
    assert.match(entry, /fs\.open\(lock, 'wx', 0o600\)/)
    assert.ok(entry.indexOf("fs.open(lock, 'wx', 0o600)") < entry.indexOf('fetch(metricUrl'), 'lock must be acquired before a metric request')
    assert.match(entry, /globalThis\.__contextcakeOnMcpInitialized = reportAnonymousActivation/)
    const engine = execFileSync('unzip', ['-p', result.file, 'engine/mcp-server.mjs'], { encoding: 'utf8' })
    assert.match(engine, /message\.method === "initialize" && !response\.error/)
    assert.ok(engine.indexOf('write(response)') < engine.indexOf('__contextcakeOnMcpInitialized'), 'the activation hook must run after the initialize response is written')

    const bundle = path.join(dir, 'bundle')
    const personal = path.join(dir, 'personal')
    const shared = path.join(dir, 'shared')
    execFileSync('unzip', ['-q', result.file, '-d', bundle])
    await Promise.all([mkdir(personal), mkdir(shared)])
    const handshake = spawnSync(process.execPath, [path.join(bundle, 'server/index.mjs'), '--personal', personal, '--shared', shared], {
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
      encoding: 'utf8',
    })
    assert.equal(handshake.status, 0, handshake.stderr)
    assert.match(handshake.stdout, new RegExp(`"serverInfo":\\{"name":"contextcake","version":"${escapedVersion}"\\}`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('npm staging package contains the CLI and engine but no lifecycle scripts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-npm-test-'))
  try {
    const { packagePath } = await buildNpmPackage({ version, outDir: dir })
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(pkg.name, 'contextcake')
    assert.equal(pkg.version, version)
    assert.deepEqual(pkg.scripts, {})
    const listing = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_cache: path.join(dir, '.npm-cache') },
    })
    const [{ files }] = JSON.parse(listing)
    const names = files.map((file) => file.path).sort()
    // The exact tarball: the bin, the whole engine source tree, the two policy
    // fixtures the engine reads at runtime, and nothing else. Engine files are
    // listed from disk so adding a module does not need a test edit, but a
    // stray file (a test, a lockfile, the rest of fixtures/) fails here.
    const engineFiles = (await readdir(new URL('../../packages/core/src', import.meta.url), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.posix.join('engine', path.relative(fileURLToPath(new URL('../../packages/core/src', import.meta.url)), path.join(entry.parentPath, entry.name)).split(path.sep).join('/')))
    const expected = [
      'LICENSE',
      'README.md',
      'bin/contextcake.mjs',
      ...NPM_POLICY_FIXTURES.map((name) => `fixtures/${name}`),
      'package.json',
      ...engineFiles,
    ].sort()
    assert.deepEqual(names, expected)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('staged npm CLI finds its default manifest through the shared platform paths', async () => {
  // The npm CLI used to carry its own config-dir guess, which answered
  // ~/.config on Windows while the app writes %APPDATA%. It now imports the
  // engine's platform-paths.mjs from its own staged layout.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-npm-paths-test-'))
  try {
    await buildNpmPackage({ version, outDir: dir })
    const configDir = path.join(dir, 'config-override')
    const help = execFileSync(process.execPath, [path.join(dir, 'bin', 'contextcake.mjs'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, CONTEXTCAKE_CONFIG_DIR: configDir, CONTEXTCAKE_MANIFEST: '' },
    })
    assert.match(help, new RegExp(`${path.join(configDir, 'manifest.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function writeMacBuild(dir, { skip = [] } = {}) {
  const macRows = RELEASE_PLATFORMS.filter((row) => row.os === 'mac')
  const bytes = (name) => `signed bytes of ${name}`
  for (const row of macRows) {
    for (const name of [row.installerName(version), row.updaterName(version)]) {
      if (!skip.includes(name)) await writeFile(path.join(dir, name), bytes(name))
    }
  }
  const files = macRows.map((row) => {
    const name = row.updaterName(version)
    return `  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes(name)).digest('base64')}\n    size: ${Buffer.byteLength(bytes(name))}\n`
  }).join('')
  await writeFile(path.join(dir, 'latest-mac.yml'), `version: ${version}\nfiles:\n${files}`)
}

test('release artifacts build together and retain a cryptographic linkage to every DMG', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-release-artifacts-test-'))
  try {
    await writeMacBuild(dir)
    const artifacts = await writeReleaseChannelArtifacts({ version, distDir: dir })
    const cask = await readFile(path.join(dir, 'contextcake.rb'), 'utf8')
    for (const row of RELEASE_PLATFORMS.filter((candidate) => candidate.os === 'mac')) {
      const installer = path.join(dir, row.installerName(version))
      assert.equal(artifacts.installers[row.id], installer)
      assert.match(cask, new RegExp(sha256(await readFile(installer))))
    }
    assert.equal(path.basename(artifacts.npmTarball), npmTarballName(version))
    const registry = JSON.parse(await readFile(path.join(dir, 'contextcake-mcp-server.json'), 'utf8'))
    assert.equal(registry.packages[0].fileSha256, sha256(await readFile(artifacts.mcpb)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('channel artifacts refuse a build that is missing a platform row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-release-artifacts-test-'))
  try {
    await writeMacBuild(dir, { skip: [`ContextCake-${version}-x64.dmg`] })
    await assert.rejects(writeReleaseChannelArtifacts({ version, distDir: dir }), /mac-x64: missing ContextCake-.+-x64\.dmg/)
    await assert.rejects(readFile(path.join(dir, 'contextcake.rb')), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the release asset list is the table plus the channel artifacts, and a draft must match it exactly', async () => {
  const names = releaseAssetNames(version)
  for (const row of RELEASE_PLATFORMS) {
    for (const name of [row.installerName(version), row.updaterName(version), row.feed, row.pingAsset].filter(Boolean)) {
      assert.ok(names.includes(name), name)
    }
  }
  for (const name of [mcpbName(version), npmTarballName(version), 'contextcake.rb', 'contextcake-mcp-server.json', 'SHA256SUMS', 'mcpb-install-ping.txt']) {
    assert.ok(names.includes(name), name)
  }
  assert.equal(new Set(names).size, names.length)

  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-release-assets-test-'))
  try {
    for (const name of names) await writeFile(path.join(dir, name), `bytes of ${name}`)
    const uploaded = names.map((name) => ({ name, size: Buffer.byteLength(`bytes of ${name}`) }))
    assert.deepEqual(verifyUploadedAssets({ version, dist: dir, uploaded }), names)

    const withoutFeed = uploaded.filter((asset) => asset.name !== 'latest-mac.yml')
    assert.throws(() => verifyUploadedAssets({ version, dist: dir, uploaded: withoutFeed }), /not uploaded: latest-mac\.yml/)
    const truncated = uploaded.map((asset) => asset.name.endsWith('-x64.dmg') ? { ...asset, size: 1 } : asset)
    assert.throws(() => verifyUploadedAssets({ version, dist: dir, uploaded: truncated }), new RegExp(`ContextCake-${escapedVersion}-x64\\.dmg uploaded 1 bytes`))
    assert.throws(() => verifyUploadedAssets({ version, dist: dir, uploaded: [...uploaded, { name: 'stray.zip', size: 3 }] }), /unexpected asset: stray\.zip/)

    const json = path.join(dir, 'assets.json')
    await writeFile(json, JSON.stringify({ assets: withoutFeed }))
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'release-assets.mjs')
    const bad = spawnSync(process.execPath, [cli, '--version', version, '--dist', dir, '--verify-uploaded', json], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr, /not uploaded: latest-mac\.yml/)
    const listed = execFileSync(process.execPath, [cli, '--version', version], { encoding: 'utf8' })
    assert.equal(listed, names.map((name) => `${name}\n`).join(''))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
