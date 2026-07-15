import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectCliStatus } from '../src/main/cli-status.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-cli-status-'))

try {
  const shim = path.join(tmp, 'ContextCake.app', 'Contents', 'Resources', 'bin', 'contextcake')
  const link = path.join(tmp, 'bin', 'contextcake')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.writeFileSync(shim, '#!/bin/sh\n')

  assert.equal(inspectCliStatus({ isPackaged: false, cliShim: shim, link }).status, 'development')
  assert.equal(inspectCliStatus({ isPackaged: true, cliShim: '/Volumes/ContextCake/Resources/bin/contextcake', link }).status, 'blocked')
  assert.equal(inspectCliStatus({ isPackaged: true, cliShim: shim, link }).status, 'missing')

  fs.writeFileSync(link, 'another command')
  assert.equal(inspectCliStatus({ isPackaged: true, cliShim: shim, link }).status, 'conflict')
  fs.unlinkSync(link)

  fs.symlinkSync(path.join(tmp, 'old-contextcake'), link)
  assert.equal(inspectCliStatus({ isPackaged: true, cliShim: shim, link }).status, 'stale')
  fs.unlinkSync(link)

  fs.symlinkSync(shim, link)
  assert.equal(inspectCliStatus({ isPackaged: true, cliShim: shim, link }).status, 'installed')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('cli status test passed')
