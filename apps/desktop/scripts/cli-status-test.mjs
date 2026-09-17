import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliLinkPath, inspectCliStatus, isOnPath, replaceCliLink } from '../src/main/cli-status.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-cli-status-'))

// A resources folder laid out the way electron-builder packages the app, so
// the shim is recognizable as a ContextCake app's own.
function appResources(root) {
  const shim = path.join(root, 'bin', 'contextcake')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.mkdirSync(path.join(root, 'engine', 'cli'), { recursive: true })
  fs.writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'engine', 'cli', 'cli.mjs'), '')
  return shim
}

try {
  // ---- macOS ------------------------------------------------------------------
  {
    const shim = appResources(path.join(tmp, 'ContextCake.app', 'Contents', 'Resources'))
    const link = path.join(tmp, 'bin', 'contextcake')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    const mac = { platform: 'darwin', pathEnv: '' }

    assert.equal(cliLinkPath({ platform: 'darwin', homedir: '/Users/ada' }), '/usr/local/bin/contextcake')

    const development = inspectCliStatus({ ...mac, isPackaged: false, cliShim: shim, link })
    assert.equal(development.status, 'development')
    assert.equal(development.shimPath, null)

    // Translocated/DMG paths are ephemeral: never hand them to the renderer as a
    // connectable command path — a harness config pointing there dies on unmount.
    const dmg = inspectCliStatus({ ...mac, isPackaged: true, cliShim: '/Volumes/ContextCake/Resources/bin/contextcake', link })
    assert.equal(dmg.status, 'blocked')
    assert.equal(dmg.shimPath, null)
    const translocated = inspectCliStatus({
      ...mac,
      isPackaged: true,
      cliShim: '/private/var/folders/ab/xyz/T/AppTranslocation/0000/d/ContextCake.app/Contents/Resources/bin/contextcake',
      link,
    })
    assert.equal(translocated.status, 'blocked')
    assert.equal(translocated.shimPath, null)

    const missing = inspectCliStatus({ ...mac, isPackaged: true, cliShim: shim, link })
    assert.equal(missing.status, 'missing')
    assert.equal(missing.shimPath, shim)
    assert.equal(missing.linkPath, link)

    fs.writeFileSync(link, 'another command')
    const conflict = inspectCliStatus({ ...mac, isPackaged: true, cliShim: shim, link })
    assert.equal(conflict.status, 'conflict')
    assert.equal(conflict.shimPath, shim)
    fs.unlinkSync(link)

    // A link to an app that is gone is stale: safe to replace.
    fs.symlinkSync(path.join(tmp, 'old-contextcake'), link)
    const stale = inspectCliStatus({ ...mac, isPackaged: true, cliShim: shim, link })
    assert.equal(stale.status, 'stale')
    assert.equal(stale.shimPath, shim)
    fs.unlinkSync(link)

    fs.symlinkSync(shim, link)
    const installed = inspectCliStatus({ ...mac, isPackaged: true, cliShim: shim, link })
    assert.equal(installed.status, 'installed')
    assert.equal(installed.shimPath, shim)
    fs.unlinkSync(link)
  }

  // ---- Linux (.deb in /opt/ContextCake, link in ~/.local/bin) -----------------
  {
    const home = path.join(tmp, 'home', 'ada')
    const shim = appResources(path.join(tmp, 'opt', 'ContextCake', 'resources'))
    const link = cliLinkPath({ platform: 'linux', homedir: home })
    assert.equal(link, path.join(home, '.local', 'bin', 'contextcake'))
    const linux = { platform: 'linux', link, pathEnv: '' }

    // Nothing on Linux is ever "blocked": /Volumes and translocation are macOS.
    const volumes = inspectCliStatus({ ...linux, isPackaged: true, cliShim: '/Volumes/ContextCake/resources/bin/contextcake' })
    assert.equal(volumes.status, 'missing')
    assert.equal(volumes.shimPath, '/Volumes/ContextCake/resources/bin/contextcake')

    const missing = inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim })
    assert.equal(missing.status, 'missing')
    assert.equal(missing.linkPath, link)
    assert.equal(missing.shimPath, shim)

    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(shim, link)
    assert.equal(inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim }).status, 'installed')
    fs.unlinkSync(link)

    // An npm-installed `contextcake` owns the name: a conflict, never replaced.
    const npmBin = path.join(home, '.npm-global', 'lib', 'node_modules', 'contextcake', 'bin', 'contextcake.mjs')
    fs.mkdirSync(path.dirname(npmBin), { recursive: true })
    fs.writeFileSync(npmBin, '#!/usr/bin/env node\n', { mode: 0o755 })
    fs.symlinkSync(npmBin, link)
    const npmOwned = inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim })
    assert.equal(npmOwned.status, 'conflict')
    assert.equal(npmOwned.shimPath, shim)
    fs.unlinkSync(link)

    // A link to another copy of the app (an old unpacked build) is stale.
    const otherShim = appResources(path.join(tmp, 'old-build', 'resources'))
    fs.symlinkSync(otherShim, link)
    assert.equal(inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim }).status, 'stale')
    fs.unlinkSync(link)

    // A real file is a conflict on Linux too.
    fs.writeFileSync(link, 'mine')
    assert.equal(inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim }).status, 'conflict')
    fs.unlinkSync(link)

    assert.equal(isOnPath(path.dirname(link), { pathEnv: `/usr/bin:${path.dirname(link)}/`, platform: 'linux' }), true)
    assert.equal(isOnPath(path.dirname(link), { pathEnv: '/usr/bin:/bin', platform: 'linux' }), false)
    assert.equal('onPath' in inspectCliStatus({ ...linux, isPackaged: true, cliShim: shim }), false)

    // ---- replaceCliLink: the unlink path of installCli ----------------------
    // Creates the link folder and the link when nothing is there.
    fs.rmSync(path.dirname(link), { recursive: true, force: true })
    replaceCliLink({ cliShim: shim, link })
    assert.equal(fs.readlinkSync(link), shim)

    // Replaces a link to another copy of the app, and a dangling link.
    fs.unlinkSync(link)
    fs.symlinkSync(otherShim, link)
    replaceCliLink({ cliShim: shim, link })
    assert.equal(fs.readlinkSync(link), shim)
    fs.unlinkSync(link)
    fs.symlinkSync(path.join(tmp, 'gone', 'contextcake'), link)
    replaceCliLink({ cliShim: shim, link })
    assert.equal(fs.readlinkSync(link), shim)

    // The link changed after the status check (stale then) and now points at
    // the npm CLI: it is re-read before unlinking and left alone.
    fs.unlinkSync(link)
    fs.symlinkSync(npmBin, link)
    assert.throws(() => replaceCliLink({ cliShim: shim, link }), (error) => error.code === 'EEXIST')
    assert.equal(fs.readlinkSync(link), npmBin)
    fs.unlinkSync(link)

    // A real file is never unlinked.
    fs.writeFileSync(link, 'mine')
    assert.throws(() => replaceCliLink({ cliShim: shim, link }), (error) => error.code === 'EEXIST')
    assert.equal(fs.readFileSync(link, 'utf8'), 'mine')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('cli status test passed')
