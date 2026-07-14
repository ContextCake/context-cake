#!/usr/bin/env node
// `contextcake` CLI — a thin dispatcher over the bundled engine entrypoints.
// Runs under ELECTRON_RUN_AS_NODE via the shim in Resources/bin (packaged) or
// plain `node` (dev checkout). Works with the app closed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Packaged layout: Resources/engine/cli/cli.mjs → Resources/engine/src.
// Dev checkout: apps/desktop/src/cli/cli.mjs → packages/core/src.
function engineSrc() {
  const packaged = path.resolve(here, '..', 'src')
  if (fs.existsSync(path.join(packaged, 'mcp-server.mjs'))) return packaged
  // apps/desktop/src/cli → repo root is four levels up.
  const dev = path.resolve(here, '..', '..', '..', '..', 'packages', 'core', 'src')
  if (fs.existsSync(path.join(dev, 'mcp-server.mjs'))) return dev
  console.error('contextcake: cannot locate the engine (looked in %s and %s)', packaged, dev)
  process.exit(1)
}

// Same dir the app uses (app.getPath('userData') for productName ContextCake).
const CONFIG_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ContextCake')
const DEFAULT_MANIFEST = path.join(CONFIG_DIR, 'manifest.json')

const COMMANDS = {
  mcp: { entry: 'mcp-server.mjs', manifest: true, blurb: 'serve the resolved graph over stdio MCP' },
  resolve: { entry: 'resolver.mjs', manifest: true, blurb: 'resolve a concept across layers' },
  ingest: { entry: 'ingest.mjs', manifest: false, blurb: 'classify repo events into signals' },
  write: { entry: 'write.mjs', manifest: true, blurb: 'write captured signals into a layer' },
  promote: { entry: 'promote.mjs', manifest: false, blurb: 'promote a concept up one layer' },
}

function usage() {
  console.log('contextcake <command> [options]\n')
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(9)} ${c.blurb}`)
  }
  console.log(`\nCommands taking --manifest default to:\n  ${DEFAULT_MANIFEST}`)
  console.log('\nConnect a harness:  claude mcp add contextcake -- contextcake mcp')
}

const [cmd, ...rest] = process.argv.slice(2)

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  usage()
  process.exit(cmd ? 0 : 1)
}

if (cmd === '--version' || cmd === '-v') {
  // The engine and app version in one line, best-effort.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'))
    console.log(pkg.version ?? '0.0.0')
  } catch {
    console.log('unknown')
  }
  process.exit(0)
}

const command = COMMANDS[cmd]
if (!command) {
  console.error(`contextcake: unknown command '${cmd}'\n`)
  usage()
  process.exit(1)
}

const args = [...rest]
if (command.manifest && !args.includes('--manifest') && !args.includes('--personal')) {
  if (!fs.existsSync(DEFAULT_MANIFEST)) {
    console.error(`contextcake: no manifest at ${DEFAULT_MANIFEST}`)
    console.error('Open the ContextCake app to run first-time setup, or pass --manifest.')
    process.exit(1)
  }
  args.unshift('--manifest', DEFAULT_MANIFEST)
}

const child = spawn(process.execPath, [path.join(engineSrc(), command.entry), ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
