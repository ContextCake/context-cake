import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkUserDataDir, pinEnv, pinnedUserDataDir } from '../src/main/user-data.mjs'
import { resolvePaths } from '../../../packages/core/src/platform-paths.mjs'

const linuxConfig = () => resolvePaths({ platform: 'linux', env: {}, homedir: '/home/ada' }).config

test('only Linux pins userData, to the engine config dir the CLI reads', () => {
  assert.equal(pinnedUserDataDir({ platform: 'linux', userDataSwitch: '', resolveConfigDir: linuxConfig }), '/home/ada/.config/contextcake')
  // macOS already matches through app.setName; nothing to pin.
  assert.equal(pinnedUserDataDir({ platform: 'darwin', userDataSwitch: '', resolveConfigDir: () => { throw new Error('not consulted') } }), null)
})

test('an explicit --user-data-dir always wins over the Linux pin', () => {
  let consulted = false
  const pinned = pinnedUserDataDir({ platform: 'linux', userDataSwitch: '/tmp/cc-test/ContextCake', resolveConfigDir: () => { consulted = true; return '/x' } })
  assert.equal(pinned, null)
  assert.equal(consulted, false)
})

test('XDG_CONFIG_HOME moves the Linux pin with it', () => {
  const resolveConfigDir = () => resolvePaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/srv/cfg' }, homedir: '/home/ada' }).config
  assert.equal(pinnedUserDataDir({ platform: 'linux', userDataSwitch: '', resolveConfigDir }), '/srv/cfg/contextcake')
})

test('the smoke check compares against the switch, then the Linux config dir, then the macOS name', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-user-data-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const dir = path.join(tmp, 'anything')
  fs.mkdirSync(dir)

  assert.equal(checkUserDataDir({ actual: dir, platform: 'linux', userDataSwitch: dir, resolveConfigDir: linuxConfig }).ok, true)
  assert.equal(checkUserDataDir({ actual: path.join(tmp, 'other'), platform: 'darwin', userDataSwitch: dir, resolveConfigDir: linuxConfig }).ok, false)
  // A symlinked tmpdir (macOS /var → /private/var) still counts as the same folder.
  assert.equal(checkUserDataDir({ actual: fs.realpathSync(dir), platform: 'darwin', userDataSwitch: dir, resolveConfigDir: linuxConfig }).ok, true)

  assert.deepEqual(
    checkUserDataDir({ actual: '/home/ada/.config/contextcake', platform: 'linux', userDataSwitch: '', resolveConfigDir: linuxConfig }),
    { ok: true, expected: '/home/ada/.config/contextcake' },
  )
  // Electron's own Linux default is the mismatch this pin exists to prevent.
  assert.equal(checkUserDataDir({ actual: '/home/ada/.config/ContextCake', platform: 'linux', userDataSwitch: '', resolveConfigDir: linuxConfig }).ok, false)

  assert.equal(checkUserDataDir({ actual: '/Users/ada/Library/Application Support/ContextCake', platform: 'darwin', userDataSwitch: '' }).ok, true)
  assert.equal(checkUserDataDir({ actual: '/Users/ada/Library/Application Support/contextcake-desktop', platform: 'darwin', userDataSwitch: '' }).ok, false)
})

test('a relative CONTEXTCAKE_CONFIG_DIR is ignored by the pin instead of crashing app.setPath', () => {
  const env = { CONTEXTCAKE_CONFIG_DIR: 'relative/cfg', XDG_CONFIG_HOME: '/srv/cfg', PATH: '/usr/bin' }
  const filtered = pinEnv(env)
  assert.equal(filtered.CONTEXTCAKE_CONFIG_DIR, undefined)
  assert.equal(filtered.XDG_CONFIG_HOME, '/srv/cfg')
  assert.equal(env.CONTEXTCAKE_CONFIG_DIR, 'relative/cfg', 'the process env is not modified')
  const resolveConfigDir = () => resolvePaths({ platform: 'linux', env: pinEnv(env), homedir: '/home/ada' }).config
  assert.equal(pinnedUserDataDir({ platform: 'linux', userDataSwitch: '', resolveConfigDir }), '/srv/cfg/contextcake')
  // An absolute override still wins.
  assert.equal(pinEnv({ CONTEXTCAKE_CONFIG_DIR: '/abs/cfg' }).CONTEXTCAKE_CONFIG_DIR, '/abs/cfg')
})

test('the pin never hands app.setPath a relative path', () => {
  assert.equal(pinnedUserDataDir({ platform: 'linux', userDataSwitch: '', resolveConfigDir: () => 'still/relative' }), null)
})
