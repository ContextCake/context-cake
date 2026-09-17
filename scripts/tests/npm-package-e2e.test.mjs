// The npm CLI as a user gets it: build the package, `npm pack` it, install the
// tarball into a throwaway prefix with scripts ignored, and drive the installed
// `contextcake` binary with no app and no repo checkout behind it.
//
// Runs in the ubuntu `engine` CI job (release group). The flow is the one a
// user without the app follows: init, `source add`, then `list_concepts` over
// MCP.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildNpmPackage, npmTarballName } from '../distribution-artifacts.mjs'

const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const version = rootPackage.version

function npmEnv(dir) {
  return {
    ...process.env,
    npm_config_ignore_scripts: 'true',
    npm_config_cache: path.join(dir, '.npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
}

// Sends each request once the previous answer arrived, then closes stdin.
function mcpSession(bin, args, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const responses = []
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`MCP session timed out. stderr:\n${stderr}`))
    }, 30_000)
    const next = () => {
      if (responses.length === requests.length) child.stdin.end()
      else child.stdin.write(`${JSON.stringify(requests[responses.length])}\n`)
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        responses.push(JSON.parse(line))
        next()
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, responses, stderr })
    })
    next()
  })
}

test('the packed npm tarball installs and runs help, init, and MCP with no app present', { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-npm-e2e-'))
  try {
    const staging = path.join(dir, 'staging')
    const prefix = path.join(dir, 'prefix')
    const configDir = path.join(dir, 'config')
    const content = path.join(dir, 'notes')
    await buildNpmPackage({ version, outDir: staging })
    execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: staging, env: npmEnv(dir), stdio: 'pipe' })
    const tarball = path.join(dir, npmTarballName(version))
    execFileSync('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', tarball], { env: npmEnv(dir), stdio: 'pipe' })
    // Nothing in the repo may leak in: the installed copy runs from the prefix.
    await rm(staging, { recursive: true, force: true })

    const bin = process.platform === 'win32' ? path.join(prefix, 'contextcake.cmd') : path.join(prefix, 'bin', 'contextcake')
    const env = {
      ...process.env,
      CONTEXTCAKE_CONFIG_DIR: configDir,
      CONTEXTCAKE_DATA_DIR: path.join(dir, 'data'),
      CONTEXTCAKE_CACHE_DIR: path.join(dir, 'cache'),
      CONTEXTCAKE_MANIFEST: '',
    }
    const run = (args) => execFileSync(bin, args, { env, encoding: 'utf8' })

    assert.equal(run(['--version']).trim(), version)
    const help = JSON.parse(run(['help', '--json']))
    assert.equal(help.ok, true)
    assert.ok(help.data.commands.some((command) => command.id === 'init'))

    const init = JSON.parse(run(['init', '--json']))
    assert.equal(init.ok, true)
    assert.equal(init.data.created, true)
    assert.equal(init.data.manifestPath, path.join(configDir, 'manifest.json'))
    assert.match(init.context.manifestRevision, /^sha256:[a-f0-9]{64}$/)

    // A folder added through the CLI, the way a user without the app would.
    await mkdir(content)
    await writeFile(path.join(content, 'hello.md'), '# Hello\n\nFrom the packed CLI.\n')
    const added = JSON.parse(run(['source', 'add', 'notes', '--path', content, '--expect-revision', init.context.manifestRevision, '--json']))
    assert.equal(added.ok, true)
    assert.equal(added.data.hasDocuments, true)
    const tested = JSON.parse(run(['source', 'test', '--json']))
    assert.deepEqual(tested.coverage, { complete: true, degraded: [] })

    const session = await mcpSession(bin, ['mcp'], env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_concepts', arguments: {} } },
    ])
    assert.equal(session.code, 0, session.stderr)
    const [initialize, tools, concepts] = session.responses
    assert.equal(initialize.result.serverInfo.name, 'contextcake')
    const names = tools.result.tools.map((tool) => tool.name)
    for (const name of ['search', 'read_file', 'list_concepts', 'get_links']) assert.ok(names.includes(name), `missing ${name}`)
    // The concept from the folder `source add` wrote is what MCP serves.
    assert.ok(!concepts.result.isError, JSON.stringify(concepts))
    assert.match(concepts.result.content.map((part) => part.text).join('\n'), /\bhello\b/)

    // The policy fixtures shipped: ingest reads context-policy.json on start.
    const ingestOut = path.join(dir, 'signals.json')
    const events = path.join(dir, 'events.json')
    await writeFile(events, '[]\n')
    run(['ingest', '--events', events, '--out', ingestOut])
    assert.ok(JSON.parse(await readFile(ingestOut, 'utf8')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
