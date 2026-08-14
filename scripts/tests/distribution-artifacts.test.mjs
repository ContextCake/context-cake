import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertHomebrewCask,
  buildMcpb,
  buildNpmPackage,
  dmgName,
  mcpbName,
  npmTarballName,
  renderHomebrewCask,
  renderMcpManifest,
  renderMcpRegistryRecord,
  sha256,
  writeReleaseChannelArtifacts,
} from '../distribution-artifacts.mjs'

const version = '0.7.3'
const digest = 'a'.repeat(64)

test('Homebrew cask is pinned to the signed app release and exposes the bundled CLI', () => {
  const cask = renderHomebrewCask({ version, dmgSha256: digest })
  assert.match(cask, /app-v#\{version\}\/ContextCake-#\{version\}-arm64\.dmg/)
  assert.match(cask, /auto_updates true/)
  assert.match(cask, /binary "#\{appdir\}\/ContextCake\.app\/Contents\/Resources\/bin\/contextcake"/)
  assert.doesNotMatch(cask, /zap /)
  assertHomebrewCask(cask, { version, dmgSha256: digest })
  assert.throws(() => assertHomebrewCask(cask.replace(version, '9.9.9'), { version, dmgSha256: digest }), /does not match/)
})

test('MCPB metadata requires an explicit manifest and leaves anonymous activation off by default', () => {
  const manifest = renderMcpManifest(version)
  assert.equal(manifest.manifest_version, '0.3')
  assert.equal(manifest.server.mcp_config.args.at(-1), '${user_config.manifest_path}')
  assert.equal(manifest.user_config.anonymous_metrics.default, false)
  assert.match(manifest.user_config.anonymous_metrics.description, /No files, paths, prompts, account data, device ID, or request body/)
  const registry = renderMcpRegistryRecord({ version, fileSha256: digest })
  assert.equal(registry.packages[0].registryType, 'mcpb')
  assert.match(registry.packages[0].identifier, /ContextCake-0\.7\.3\.mcpb$/)
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
    assert.match(handshake.stdout, /"serverInfo":\{"name":"contextcake","version":"0\.7\.3"\}/)
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
    const names = files.map((file) => file.path)
    assert.ok(names.includes('bin/contextcake.mjs'))
    assert.ok(names.includes('engine/mcp-server.mjs'))
    assert.ok(names.every((name) => !name.includes('node_modules')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('release artifacts build together and retain a cryptographic linkage to the DMG', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-release-artifacts-test-'))
  try {
    await writeFile(path.join(dir, dmgName(version)), 'signed-app-bytes')
    const artifacts = await writeReleaseChannelArtifacts({ version, distDir: dir })
    const cask = await readFile(path.join(dir, 'contextcake.rb'), 'utf8')
    assert.match(cask, new RegExp(sha256(await readFile(artifacts.dmg))))
    assert.equal(path.basename(artifacts.npmTarball), npmTarballName(version))
    const registry = JSON.parse(await readFile(path.join(dir, 'contextcake-mcp-server.json'), 'utf8'))
    assert.equal(registry.packages[0].fileSha256, sha256(await readFile(artifacts.mcpb)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
