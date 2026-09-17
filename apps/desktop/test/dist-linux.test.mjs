import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkPackagedAccounts, debMaintainer, electronBuilderArgs } from '../scripts/dist-linux.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dist-linux.mjs')

test('the .deb build refuses to run without a maintainer from the environment', () => {
  assert.throws(() => debMaintainer({}), /CC_DEB_MAINTAINER/)
  assert.throws(() => debMaintainer({ CC_DEB_MAINTAINER: '   ' }), /DEB_MAINTAINER repository variable/)
  assert.equal(debMaintainer({ CC_DEB_MAINTAINER: ' ContextCake builds ' }), 'ContextCake builds')

  // The CLI fails before electron-builder starts, with the message on stderr.
  const env = { ...process.env }
  delete env.CC_DEB_MAINTAINER
  const run = spawnSync(process.execPath, [SCRIPT, '--publish', 'never'], { env, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /dist:linux needs CC_DEB_MAINTAINER/)
})

test('the maintainer reaches electron-builder as one argument, ahead of the caller\'s flags', () => {
  assert.deepEqual(
    electronBuilderArgs({ maintainer: 'Team Name <team>', extraArgs: ['--publish', 'never'] }),
    ['--linux', '--config.deb.maintainer=Team Name <team>', '--publish', 'never'],
  )
})

test('the packaged resources must carry the disabled-accounts marker the build wrote', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dist-linux-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const resourcesDir = path.join(dir, 'resources')
  const buildConfigFile = path.join(dir, 'supabase-config.json')
  const disabled = `${JSON.stringify({ accounts: 'disabled' }, null, 2)}\n`
  fs.mkdirSync(resourcesDir)
  fs.writeFileSync(buildConfigFile, disabled)

  assert.throws(() => checkPackagedAccounts({ resourcesDir, buildConfigFile, env: {} }), /has no .*supabase-config\.json/)

  fs.writeFileSync(path.join(resourcesDir, 'supabase-config.json'), '{"accounts":"disabled"}')
  assert.throws(() => checkPackagedAccounts({ resourcesDir, buildConfigFile, env: {} }), /stale accounts marker/)

  fs.writeFileSync(path.join(resourcesDir, 'supabase-config.json'), disabled)
  assert.equal(checkPackagedAccounts({ resourcesDir, buildConfigFile, env: {} }), path.join(resourcesDir, 'supabase-config.json'))

  const enabled = JSON.stringify({ accounts: 'enabled', url: 'https://x.supabase.co', anonKey: 'sb_publishable_x' })
  fs.writeFileSync(buildConfigFile, enabled)
  fs.writeFileSync(path.join(resourcesDir, 'supabase-config.json'), enabled)
  assert.throws(() => checkPackagedAccounts({ resourcesDir, buildConfigFile, env: {} }), /CC_ACCOUNTS=1 was not set/)
  assert.ok(checkPackagedAccounts({ resourcesDir, buildConfigFile, env: { CC_ACCOUNTS: '1' } }))
})
