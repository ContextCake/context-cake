#!/usr/bin/env node
// `contextcake` CLI — a thin dispatcher over the bundled engine entrypoints.
// Runs under ELECTRON_RUN_AS_NODE via the shim in Resources/bin (packaged) or
// plain `node` (dev checkout). Works with the app closed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readCliVersion } from './version.mjs'

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

// The engine's platform-paths.mjs is the one answer for where the manifest
// lives, shared with the npm CLI. On macOS it must equal the app's
// app.getPath('userData'), which is pinned to "ContextCake" via app.setName in
// src/main/main.mjs — change one and `contextcake mcp` can't find the manifest
// the app wrote.
const { resolvePaths } = await import(pathToFileURL(path.join(engineSrc(), 'platform-paths.mjs')).href)
const { config: CONFIG_DIR, manifest: DEFAULT_MANIFEST } = resolvePaths()

const COMMANDS = {
  doctor: { entry: 'doctor.mjs', manifest: true, blurb: 'check profile configuration and source folders' },
  mcp: { entry: 'mcp-server.mjs', manifest: true, blurb: 'serve the resolved graph over stdio MCP' },
  resolve: { entry: 'resolver.mjs', manifest: true, blurb: 'resolve a concept across layers' },
  ingest: { entry: 'ingest.mjs', manifest: false, blurb: 'classify repo events into signals' },
  write: { entry: 'write.mjs', manifest: true, blurb: 'write captured signals into a layer' },
  promote: { entry: 'promote.mjs', manifest: true, blurb: 'promote a live capture inside one profile' },
  pack: { entry: 'pack-cli.mjs', manifest: false, blurb: 'inspect, install, update, and roll back local Packs' },
  profile: { entry: 'profile-cli.mjs', manifest: true, blurb: 'inspect and manage project profiles' },
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
  console.log(readCliVersion(here))
  process.exit(0)
}

const command = COMMANDS[cmd]
if (!command) {
  console.error(`contextcake: unknown command '${cmd}'\n`)
  usage()
  process.exit(1)
}

const args = [...rest]
const isHelp = args.some((arg) => ['help', '--help', '-h'].includes(arg))
if (command.manifest && !isHelp && !args.includes('--manifest') && !args.includes('--personal') && !args.includes('--legacy-paths')) {
  if (cmd !== 'doctor' && !fs.existsSync(DEFAULT_MANIFEST)) {
    console.error(`contextcake: no manifest at ${DEFAULT_MANIFEST}`)
    console.error('Open the ContextCake app to run first-time setup, or pass --manifest.')
    process.exit(1)
  }
  args.unshift('--manifest', DEFAULT_MANIFEST)
}
if (cmd === 'pack' && !['inspect', 'help', '--help', '-h'].includes(args[0]) && !args.includes('--manifest')) {
  if (!fs.existsSync(DEFAULT_MANIFEST)) {
    console.error(`contextcake: no manifest at ${DEFAULT_MANIFEST}`)
    console.error('Open the ContextCake app to run first-time setup, or pass --manifest.')
    process.exit(1)
  }
  args.splice(1, 0, '--manifest', DEFAULT_MANIFEST)
}

// This forks a SECOND, independent engine over the same manifest the app's
// engine is already serving — deliberate (the CLI must work with the app
// closed) but not free, and `contextcake mcp` is the long-lived case that
// normally runs while the app is open. What actually contends:
//
//   - Reads. MCP owns a retained, profile-bound index. Warm searches recheck
//     listings and fingerprints without rereading unchanged documents. Cold
//     scans and the desktop's background index remain independent.
//   - Foreign MCP layers. Each engine spawns its own child per "source":"mcp"
//     layer, so one manifest entry becomes two running server processes.
//   - Disk cache. Layers with a `cache` block share one directory. Writes are
//     pid-scoped tmp + rename so neither corrupts the other, but each process
//     keeps its own memory cache and its own TTL clock.
//   - Live git layers. git-core.mjs's advisory .contextcake.lock serializes
//     mutations; the loser SKIPS its pull rather than blocking, so which
//     engine sees fresh commits depends on who got the lock.
//
// Future: when the app is running, dispatch to its already-warm loopback
// service instead of forking. The blocker is the bearer — it is minted per
// launch and travels up the engine message port precisely so it never lands in
// argv, env, or a file the CLI could read, so that handoff needs designing.
const engineEntry = path.join(engineSrc(), command.entry)
const observability = path.resolve(here, '..', 'observability', cmd === 'doctor' ? 'doctor-launcher.mjs' : 'mcp-launcher.mjs')
const childArgs = ['mcp','doctor'].includes(cmd) ? [observability, engineEntry, path.join(CONFIG_DIR, 'local-observability.json'), ...args] : [engineEntry, ...args]
const child = spawn(process.execPath, childArgs, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
