import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { wrapSpawn } from '../src/cli/cli.mjs'

const cli = fileURLToPath(new URL('../src/cli/cli.mjs', import.meta.url))
const paths = { config: '/cfg', data: '/data', cache: '/cache', manifest: '/cfg/manifest.json' }

test('mcp and doctor run through the observability launchers under ELECTRON_RUN_AS_NODE', () => {
  for (const command of ['mcp', 'doctor']) {
    const wrapped = wrapSpawn({ command, entry: '/engine/src/x.mjs', args: ['--manifest', '/m.json'], env: { KEEP: '1' }, paths })
    assert.match(wrapped.args[0], new RegExp(`observability[\\\\/]${command}-launcher\\.mjs$`))
    assert.deepEqual(wrapped.args.slice(1), ['/engine/src/x.mjs', path.join('/cfg', 'local-observability.json'), '--manifest', '/m.json'])
    assert.equal(wrapped.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(wrapped.env.KEEP, '1')
  }
  const plain = wrapSpawn({ command: 'resolve', entry: '/engine/src/resolver.mjs', args: ['--concept', 'a'], env: {}, paths })
  assert.deepEqual(plain.args, ['/engine/src/resolver.mjs', '--concept', 'a'])
  assert.equal(plain.env.ELECTRON_RUN_AS_NODE, '1')
})

test('the app CLI wraps the engine dispatcher and reports the app version', () => {
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/)
  const help = spawnSync(process.execPath, [cli, 'help', '--json'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  const body = JSON.parse(help.stdout)
  assert.equal(body.data.version, version.stdout.trim())
  assert.ok(body.data.commands.some((command) => command.id === 'doctor'))
})
