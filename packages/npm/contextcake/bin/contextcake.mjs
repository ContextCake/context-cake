#!/usr/bin/env node
// The standalone npm CLI carries the same dependency-free engine that ships in
// ContextCake for Mac.  It intentionally has no install or lifecycle scripts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engine = path.resolve(here, '..', 'engine')
const configDir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'ContextCake')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ContextCake')
const defaultManifest = path.join(configDir, 'manifest.json')

const commands = {
  mcp: { entry: 'mcp-server.mjs', manifest: true, blurb: 'serve the resolved graph over stdio MCP' },
  resolve: { entry: 'resolver.mjs', manifest: true, blurb: 'resolve a concept across layers' },
  ingest: { entry: 'ingest.mjs', manifest: false, blurb: 'classify repo events into signals' },
  write: { entry: 'write.mjs', manifest: true, blurb: 'write captured signals into a layer' },
  promote: { entry: 'promote.mjs', manifest: true, blurb: 'promote a live capture inside one profile' },
  pack: { entry: 'pack-cli.mjs', manifest: false, blurb: 'inspect, install, update, and roll back local Packs' },
  profile: { entry: 'profile-cli.mjs', manifest: true, blurb: 'inspect and manage project profiles' },
}

function usage(exitCode = 0) {
  console.log('contextcake <command> [options]\n')
  for (const [name, command] of Object.entries(commands)) console.log(`  ${name.padEnd(9)} ${command.blurb}`)
  console.log(`\nCommands taking --manifest default to:\n  ${defaultManifest}`)
  console.log('\nConnect a harness:  claude mcp add contextcake -- contextcake mcp')
  process.exit(exitCode)
}

const [name, ...rest] = process.argv.slice(2)
if (!name || ['help', '--help', '-h'].includes(name)) usage(name ? 0 : 1)
if (['--version', '-v'].includes(name)) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'))
  console.log(pkg.version)
  process.exit(0)
}

const command = commands[name]
if (!command) {
  console.error(`contextcake: unknown command '${name}'\n`)
  usage(1)
}
const args = [...rest]
const isHelp = args.some((arg) => ['help', '--help', '-h'].includes(arg))
if (command.manifest && !isHelp && !args.includes('--manifest') && !args.includes('--personal') && !args.includes('--legacy-paths')) {
  if (!fs.existsSync(defaultManifest)) {
    console.error(`contextcake: no manifest at ${defaultManifest}`)
    console.error('Create one in the ContextCake app, or pass --manifest.')
    process.exit(1)
  }
  args.unshift('--manifest', defaultManifest)
}
if (name === 'pack' && !['inspect', 'help', '--help', '-h'].includes(args[0]) && !args.includes('--manifest')) {
  if (!fs.existsSync(defaultManifest)) {
    console.error(`contextcake: no manifest at ${defaultManifest}`)
    console.error('Create one in the ContextCake app, or pass --manifest.')
    process.exit(1)
  }
  args.splice(1, 0, '--manifest', defaultManifest)
}

const child = spawn(process.execPath, [path.join(engine, command.entry), ...args], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
