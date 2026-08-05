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

  const development = inspectCliStatus({ isPackaged: false, cliShim: shim, link })
  assert.equal(development.status, 'development')
  assert.equal(development.shimPath, null)

  // Translocated/DMG paths are ephemeral: never hand them to the renderer as a
  // connectable command path — a harness config pointing there dies on unmount.
  const dmg = inspectCliStatus({ isPackaged: true, cliShim: '/Volumes/ContextCake/Resources/bin/contextcake', link })
  assert.equal(dmg.status, 'blocked')
  assert.equal(dmg.shimPath, null)
  const translocated = inspectCliStatus({
    isPackaged: true,
    cliShim: '/private/var/folders/ab/xyz/T/AppTranslocation/0000/d/ContextCake.app/Contents/Resources/bin/contextcake',
    link,
  })
  assert.equal(translocated.status, 'blocked')
  assert.equal(translocated.shimPath, null)

  const missing = inspectCliStatus({ isPackaged: true, cliShim: shim, link })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.shimPath, shim)

  fs.writeFileSync(link, 'another command')
  const conflict = inspectCliStatus({ isPackaged: true, cliShim: shim, link })
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.shimPath, shim)
  fs.unlinkSync(link)

  fs.symlinkSync(path.join(tmp, 'old-contextcake'), link)
  const stale = inspectCliStatus({ isPackaged: true, cliShim: shim, link })
  assert.equal(stale.status, 'stale')
  assert.equal(stale.shimPath, shim)
  fs.unlinkSync(link)

  fs.symlinkSync(shim, link)
  const installed = inspectCliStatus({ isPackaged: true, cliShim: shim, link })
  assert.equal(installed.status, 'installed')
  assert.equal(installed.shimPath, shim)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('cli status test passed')
