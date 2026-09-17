// The POSIX sh shim that `contextcake` links point at. It runs before any Node
// exists, so it is tested the way it is used: exec'd through a symlink from a
// fake install of each app layout.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'bin', 'contextcake')

// Stands in for the Electron binary: prints what the shim ran it with.
const FAKE_ELECTRON = '#!/bin/sh\necho "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\necho "$0"\nfor arg in "$@"; do echo "$arg"; done\n'

function install(resources, binary) {
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(resources, 'engine', 'cli'), { recursive: true })
  fs.copyFileSync(SHIM, path.join(resources, 'bin', 'contextcake'))
  fs.chmodSync(path.join(resources, 'bin', 'contextcake'), 0o755)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, FAKE_ELECTRON, { mode: 0o755 })
}

function runThroughLink(t, resources) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shim-link-'))
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }))
  const link = path.join(binDir, 'contextcake')
  fs.symlinkSync(path.join(resources, 'bin', 'contextcake'), link)
  return spawnSync(link, ['mcp', '--scope', 'a b'], { encoding: 'utf8' })
}

function tempRoot(t) {
  // realpath: the shim resolves with `pwd -P`, and macOS tmp is a symlink.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shim-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('the shim ships executable', () => {
  assert.equal(fs.statSync(SHIM).mode & 0o755, 0o755)
  assert.match(fs.readFileSync(SHIM, 'utf8'), /^#!\/bin\/sh\n/)
})

test('macOS: a link runs ContextCake.app/Contents/MacOS/ContextCake as Node on the bundled CLI', (t) => {
  const root = tempRoot(t)
  const resources = path.join(root, 'ContextCake.app', 'Contents', 'Resources')
  install(resources, path.join(root, 'ContextCake.app', 'Contents', 'MacOS', 'ContextCake'))
  const run = runThroughLink(t, resources)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'ELECTRON_RUN_AS_NODE=1',
    path.join(root, 'ContextCake.app', 'Contents', 'MacOS', 'ContextCake'),
    path.join(resources, 'engine', 'cli', 'cli.mjs'),
    'mcp', '--scope', 'a b',
  ])
})

test('Linux .deb: a link runs /opt/ContextCake/contextcake-desktop as Node on the bundled CLI', (t) => {
  const root = tempRoot(t)
  const resources = path.join(root, 'opt', 'ContextCake', 'resources')
  install(resources, path.join(root, 'opt', 'ContextCake', 'contextcake-desktop'))
  const run = runThroughLink(t, resources)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'ELECTRON_RUN_AS_NODE=1',
    path.join(root, 'opt', 'ContextCake', 'contextcake-desktop'),
    path.join(resources, 'engine', 'cli', 'cli.mjs'),
    'mcp', '--scope', 'a b',
  ])
})

test('a link into an uninstalled app fails with a reinstall hint', (t) => {
  const root = tempRoot(t)
  const resources = path.join(root, 'opt', 'ContextCake', 'resources')
  install(resources, path.join(root, 'elsewhere', 'contextcake-desktop'))
  const run = runThroughLink(t, resources)
  assert.equal(run.status, 1)
  assert.match(run.stderr, /cannot find the ContextCake app/)
  assert.match(run.stderr, /Reinstall the app/)
})
