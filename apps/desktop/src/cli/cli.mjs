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

// Must match the app's app.getPath('userData'), which is pinned to
// "ContextCake" via app.setName in src/main/main.mjs. If you change one, change
// both — otherwise `contextcake mcp` can't find the manifest the app wrote.
const CONFIG_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ContextCake')
const DEFAULT_MANIFEST = path.join(CONFIG_DIR, 'manifest.json')

const COMMANDS = {
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
const isHelp = args.some((arg) => ['help', '--help', '-h'].includes(arg))
if (command.manifest && !isHelp && !args.includes('--manifest') && !args.includes('--personal') && !args.includes('--legacy-paths')) {
  if (!fs.existsSync(DEFAULT_MANIFEST)) {
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
//   - Reads. mcp-server.mjs has no background index: every list_concepts /
//     search walks each layer root and loads every concept again. So both
//     processes walk the same folders, sharing only the OS page cache — on a
//     3,000-note vault that is a full re-walk per tool call beside an engine
//     that had the answer indexed.
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
const child = spawn(process.execPath, [path.join(engineSrc(), command.entry), ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
