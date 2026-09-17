#!/usr/bin/env node
// Release-channel builders deliberately live outside packages/core: these tools
// package the dependency-free engine but must never make the engine depend on a
// package manager, a registry client, or a telemetry SDK.
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RELEASE_PLATFORMS, releaseFileNames, verifyReleaseDirectory } from './release-platforms.mjs'

export const REPOSITORY = 'ContextCake/context-cake'
export const MCPB_NAME = 'contextcake.mcpb'
export const MCPB_INSTALL_METRIC_ASSET = 'mcpb-install-ping.txt'
export const HOMEBREW_CASK_NAME = 'contextcake'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versionPattern = /^\d+\.\d+\.\d+$/

export function assertReleaseVersion(version) {
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error('Distribution artifacts require a stable X.Y.Z version.')
  }
  return version
}

export function mcpbName(version) {
  return `ContextCake-${assertReleaseVersion(version)}.mcpb`
}

export function npmTarballName(version) {
  return `contextcake-${assertReleaseVersion(version)}.tgz`
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export const CHANNEL_METADATA_ASSETS = Object.freeze(['contextcake.rb', 'contextcake-mcp-server.json', 'SHA256SUMS'])

// Every file a GitHub Release for `version` attaches: each platform row's
// installer, update file, feed, and install ping, plus the channel artifacts.
// The workflow uploads exactly this list and checks the draft against it
// before making the release public.
export function releaseAssetNames(version) {
  assertReleaseVersion(version)
  const table = ['installers', 'updaters', 'feeds', 'pings'].flatMap((kind) => releaseFileNames({ version, kind }))
  return [...table, mcpbName(version), npmTarballName(version), ...CHANNEL_METADATA_ASSETS, MCPB_INSTALL_METRIC_ASSET]
}

// `uploaded` is the asset list GitHub reports for the draft ([{ name, size }]).
// The draft must carry exactly the expected names, each with the byte size of
// the local file it came from. Throws one error listing every difference.
export function verifyUploadedAssets({ version, dist, uploaded }) {
  const expected = releaseAssetNames(version)
  const problems = []
  const byName = new Map()
  for (const asset of uploaded ?? []) {
    if (byName.has(asset.name)) problems.push(`uploaded twice: ${asset.name}`)
    byName.set(asset.name, asset)
  }
  for (const name of expected) {
    const asset = byName.get(name)
    if (!asset) {
      problems.push(`not uploaded: ${name}`)
      continue
    }
    const local = path.join(dist, name)
    const size = fs.existsSync(local) ? fs.statSync(local).size : null
    if (asset.state !== undefined && asset.state !== 'uploaded') problems.push(`${name} upload state is ${asset.state}`)
    if (size === null) problems.push(`no local file for ${name}`)
    else if (asset.size !== size) problems.push(`${name} uploaded ${asset.size} bytes, local file is ${size}`)
  }
  for (const name of byName.keys()) {
    if (!expected.includes(name)) problems.push(`unexpected asset: ${name}`)
  }
  if (problems.length) throw new Error(`Release ${version} draft does not match the platform table:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  return expected
}

// Homebrew's arch keys for each Mac row. A Mac row with an arch missing here
// fails loudly rather than leaving that Mac out of the cask.
const HOMEBREW_ARCH = { arm64: 'arm', x64: 'intel' }

function macRows() {
  return RELEASE_PLATFORMS.filter((row) => row.os === 'mac')
}

// `digests` maps a Mac row id to its DMG's SHA-256. The cask uses Homebrew's
// standard multi-arch form: one `arch` stanza, one `sha256` with a value per
// arch, and one url that interpolates #{arch}. That form only works while every
// Mac row names its DMG the same way apart from the arch, so this checks it.
export function renderHomebrewCask({ version, digests }) {
  assertReleaseVersion(version)
  const rows = macRows()
  const urlFor = (row) => row.installerName(version).replaceAll(version, '#{version}').replaceAll(row.arch, '#{arch}')
  const dmg = urlFor(rows[0])
  const entries = rows.map((row) => {
    const key = HOMEBREW_ARCH[row.arch]
    if (!key) throw new Error(`Homebrew cask has no arch key for ${row.id}.`)
    if (urlFor(row) !== dmg) throw new Error(`Homebrew cask needs every Mac DMG to differ only by arch; ${row.id} does not.`)
    const digest = digests?.[row.id]
    if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`Homebrew cask requires a SHA-256 DMG digest for ${row.id}.`)
    return { key, arch: row.arch, digest }
  })
  const width = Math.max(...entries.map((entry) => entry.key.length)) + 1
  const archStanza = entries.map((entry) => `${entry.key}: "${entry.arch}"`).join(', ')
  const sha = entries
    .map((entry, index) => `${index === 0 ? '  sha256 ' : '         '}${`${entry.key}:`.padEnd(width)} "${entry.digest}"`)
    .join(',\n')
  return `cask "${HOMEBREW_CASK_NAME}" do
  arch ${archStanza}

  version "${version}"
${sha}

  url "https://github.com/${REPOSITORY}/releases/download/app-v#{version}/${dmg}"
  name "ContextCake"
  desc "Local-first context resolution for people and AI agents"
  homepage "https://contextcake.com"

  auto_updates true

  app "ContextCake.app"
  binary "#{appdir}/ContextCake.app/Contents/Resources/bin/contextcake"
end
`
}

export function renderMcpManifest(version) {
  assertReleaseVersion(version)
  return {
    manifest_version: '0.3',
    name: 'io.github.contextcake.contextcake',
    display_name: 'ContextCake',
    version,
    description: 'Resolve local ContextCake knowledge through MCP.',
    long_description: 'ContextCake reads local Markdown and OKF layers, then gives your MCP client sourced answers with conflicts intact.',
    author: { name: 'ContextCake', url: 'https://contextcake.com' },
    repository: { type: 'git', url: `https://github.com/${REPOSITORY}.git` },
    homepage: 'https://contextcake.com',
    documentation: 'https://contextcake.com/docs',
    support: `https://github.com/${REPOSITORY}/issues`,
    compatibility: { platforms: ['darwin'], runtimes: { node: '>=22' } },
    server: {
      type: 'node',
      entry_point: 'server/index.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.mjs', '--manifest', '${user_config.manifest_path}'],
        env: { CONTEXTCAKE_MCPB_ANONYMOUS_METRICS: '${user_config.anonymous_metrics}' },
      },
    },
    user_config: {
      manifest_path: {
        type: 'file',
        title: 'ContextCake manifest',
        description: 'Choose the local ContextCake manifest this MCP server may read.',
        required: true,
      },
      anonymous_metrics: {
        type: 'boolean',
        title: 'Share anonymous activation metrics',
        description: 'Optional. Downloads one tiny versioned file after the server starts successfully. No files, paths, prompts, account data, device ID, or request body are sent.',
        default: false,
        required: false,
      },
    },
    tools: [
      { name: 'search', description: 'Find concepts across configured ContextCake layers.' },
      { name: 'read_file', description: 'Read a resolved ContextCake concept with provenance and conflicts.' },
      { name: 'list_concepts', description: 'List concepts available to ContextCake.' },
      { name: 'get_links', description: 'Get links between ContextCake concepts.' },
    ],
    tools_generated: true,
  }
}

export function renderMcpRegistryRecord({ version, fileSha256 }) {
  assertReleaseVersion(version)
  if (!/^[a-f0-9]{64}$/.test(fileSha256)) throw new Error('MCP Registry metadata requires a SHA-256 digest.')
  return {
    '$schema': 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'io.github.contextcake.contextcake',
    title: 'ContextCake',
    description: 'Resolve local ContextCake knowledge through MCP.',
    version,
    packages: [{
      registryType: 'mcpb',
      identifier: `https://github.com/${REPOSITORY}/releases/download/app-v${version}/${mcpbName(version)}`,
      fileSha256,
      transport: { type: 'stdio' },
    }],
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed${signal ? ` (${signal})` : ` (exit ${code})`}`))
    })
  })
}

export async function buildNpmPackage({ version, outDir }) {
  assertReleaseVersion(version)
  const output = path.resolve(outDir)
  await rm(output, { recursive: true, force: true })
  await cp(path.join(root, 'packages/npm/contextcake'), output, { recursive: true })
  await cp(path.join(root, 'packages/core/src'), path.join(output, 'engine'), { recursive: true })
  const packagePath = path.join(output, 'package.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  pkg.version = version
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  return { dir: output, packagePath }
}

export async function buildMcpb({ version, outFile }) {
  assertReleaseVersion(version)
  const output = path.resolve(outFile)
  const staging = await mkdtemp(path.join(os.tmpdir(), 'contextcake-mcpb-'))
  try {
    await cp(path.join(root, 'apps/mcpb/template/server'), path.join(staging, 'server'), { recursive: true })
    await cp(path.join(root, 'packages/core/src'), path.join(staging, 'engine'), { recursive: true })
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(renderMcpManifest(version), null, 2)}\n`)
    const entryPath = path.join(staging, 'server', 'index.mjs')
    const entry = await readFile(entryPath, 'utf8')
    await writeFile(entryPath, entry.replaceAll('__CONTEXTCAKE_VERSION__', version))
    await fs.promises.mkdir(path.dirname(output), { recursive: true })
    await rm(output, { force: true })
    await run('zip', ['-q', '-r', output, '.'], { cwd: staging })
    return { file: output, sha256: sha256(await readFile(output)), manifest: renderMcpManifest(version) }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function assertVersionAlignment(version) {
  assertReleaseVersion(version)
  const packageFiles = [
    'package.json',
    'apps/desktop/package.json',
    'packages/npm/contextcake/package.json',
    'packages/npm/context-cake/package.json',
  ]
  const mismatches = []
  for (const rel of packageFiles) {
    const pkg = JSON.parse(await readFile(path.join(root, rel), 'utf8'))
    if (pkg.version !== version) mismatches.push(`${rel} is ${pkg.version}`)
  }
  if (mismatches.length) throw new Error(`Distribution version mismatch: ${mismatches.join('; ')}`)
}

export function assertHomebrewCask(cask, { version, digests }) {
  const expected = renderHomebrewCask({ version, digests })
  if (cask !== expected) throw new Error('Homebrew cask does not match the release version and DMG digests.')
  if (!cask.includes('auto_updates true') || !cask.includes('binary "#{appdir}/ContextCake.app/Contents/Resources/bin/contextcake"')) {
    throw new Error('Homebrew cask must declare the app-owned updater and bundled CLI.')
  }
}

export async function writeReleaseChannelArtifacts({ version, distDir }) {
  assertReleaseVersion(version)
  await assertVersionAlignment(version)
  const dist = path.resolve(distDir)
  // Every platform row or nothing: a cask, bundle, or tarball built beside a
  // partial set of installers would publish links to files that do not exist.
  verifyReleaseDirectory({ dir: dist, version, stage: 'build' })
  const installers = {}
  const digests = {}
  for (const row of RELEASE_PLATFORMS) {
    installers[row.id] = path.join(dist, row.installerName(version))
  }
  for (const row of macRows()) {
    digests[row.id] = sha256(await readFile(installers[row.id]))
  }
  const cask = renderHomebrewCask({ version, digests })
  assertHomebrewCask(cask, { version, digests })
  await writeFile(path.join(dist, 'contextcake.rb'), cask)

  const mcpb = await buildMcpb({ version, outFile: path.join(dist, mcpbName(version)) })
  await writeFile(
    path.join(dist, 'contextcake-mcp-server.json'),
    `${JSON.stringify(renderMcpRegistryRecord({ version, fileSha256: mcpb.sha256 }), null, 2)}\n`,
  )

  const npmStaging = await mkdtemp(path.join(os.tmpdir(), 'contextcake-npm-'))
  try {
    await buildNpmPackage({ version, outDir: npmStaging })
    await run('npm', ['pack', '--dry-run'], {
      cwd: npmStaging,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_cache: path.join(npmStaging, '.npm-cache') },
    })
    await run('npm', ['pack', '--pack-destination', dist], {
      cwd: npmStaging,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_cache: path.join(npmStaging, '.npm-cache') },
    })
  } finally {
    await rm(npmStaging, { recursive: true, force: true })
  }
  const tarball = path.join(dist, npmTarballName(version))
  if (!fs.existsSync(tarball)) throw new Error(`npm pack did not create ${npmTarballName(version)}`)
  return { installers, digests, mcpb: mcpb.file, npmTarball: tarball }
}
