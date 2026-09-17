#!/usr/bin/env node
// `contextcake` CLI for the Mac app: a thin wrapper over the engine's
// dispatcher (packages/core/src/cli.mjs), which the npm package also wraps.
// Runs under ELECTRON_RUN_AS_NODE via the shim in Resources/bin (packaged) or
// plain `node` (dev checkout). Works with the app closed.
//
// What this wrapper adds: the app's version, ELECTRON_RUN_AS_NODE for every
// spawned engine entrypoint, and the observability launchers for `mcp` and
// `doctor`. Commands, flags, and help all live in the engine's command table.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readCliVersion } from './version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// Packaged layout: Resources/engine/cli/cli.mjs → Resources/engine/src.
// Dev checkout: apps/desktop/src/cli/cli.mjs → packages/core/src.
function engineSrc() {
  const packaged = path.resolve(here, '..', 'src')
  if (fs.existsSync(path.join(packaged, 'cli.mjs'))) return packaged
  // apps/desktop/src/cli → repo root is four levels up.
  const dev = path.resolve(here, '..', '..', '..', '..', 'packages', 'core', 'src')
  if (fs.existsSync(path.join(dev, 'cli.mjs'))) return dev
  console.error('contextcake: cannot locate the engine (looked in %s and %s)', packaged, dev)
  process.exit(1)
}

// Packaged: Resources/engine/observability. Dev: apps/desktop/src/observability.
const observabilityDir = path.resolve(here, '..', 'observability')

// The engine's platform-paths.mjs is the one answer for where the manifest
// lives, shared with the npm CLI. On macOS it must equal the app's
// app.getPath('userData'), which is pinned to "ContextCake" via app.setName in
// src/main/main.mjs — change one and `contextcake mcp` can't find the manifest
// the app wrote. The engine passes those paths to the hook below.
export function wrapSpawn({ command, entry, args, env, paths }) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  if (command !== 'mcp' && command !== 'doctor') return { args: [entry, ...args], env: childEnv }
  const launcher = path.join(observabilityDir, command === 'doctor' ? 'doctor-launcher.mjs' : 'mcp-launcher.mjs')
  return {
    args: [launcher, entry, path.join(paths.config, 'local-observability.json'), ...args],
    env: childEnv,
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

// Importable without running, so tests can check wrapSpawn.
if (invokedDirectly()) {
  const { main } = await import(pathToFileURL(path.join(engineSrc(), 'cli.mjs')).href)
  await main(process.argv.slice(2), { version: readCliVersion(here), wrapSpawn })
}
