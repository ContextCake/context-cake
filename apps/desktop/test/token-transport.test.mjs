import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = fs.readFileSync(path.join(appRoot, 'src/main/main.mjs'), 'utf8')
const preloadSource = fs.readFileSync(path.join(appRoot, 'src/preload.cjs'), 'utf8')
const hostSource = fs.readFileSync(path.join(appRoot, 'src/main/service-host.mjs'), 'utf8')
const engineSource = fs.readFileSync(path.join(appRoot, 'src/main/engine-process.mjs'), 'utf8')

test('the local API bearer travels through trusted IPC, never renderer argv', () => {
  assert.doesNotMatch(mainSource, /--cc-token=/)
  assert.doesNotMatch(preloadSource, /arg\(['"]cc-token['"]\)/)
  assert.match(mainSource, /handleTrustedIpc\(['"]contextcake:get-api-token['"]/)
  assert.match(preloadSource, /ipcRenderer\.invoke\(['"]contextcake:get-api-token['"]\)/)
})

test('source credentials reach the engine over the message port, never argv or env', () => {
  // The fork passes exactly three plain paths. A credential appearing in that
  // array would be readable by any process on the machine via `ps`.
  const fork = hostSource.match(/utilityProcess\.fork\([\s\S]*?\n {2}\)/)?.[0] ?? ''
  assert.ok(fork, 'could not locate the fork call')
  assert.match(fork, /\[manifestPath\(\), serviceModule, consoleDist \?\? ''\]/)
  assert.doesNotMatch(fork, /token|secret|credential/i)
  // ...and no env carrying them either.
  assert.doesNotMatch(fork, /\benv\b/)

  // The port is the only path in. (The helper became `acks.send` when reload
  // acknowledgements were made honest; the property it guards is unchanged —
  // the credential map is posted down the message port and nowhere else.)
  assert.match(hostSource, /acks\.send\(\{ type: 'tokens', tokens/)
  assert.match(engineSource, /message\.type === 'tokens'/)
  assert.match(engineSource, /service\.setTokens\(/)
})

test('the renderer can never read a stored credential back out', () => {
  // Only list/add/disconnect are exposed, and list() is metadata-only (proved
  // behaviorally in github-connections.test.mjs). There must be no channel
  // whose purpose is handing a secret to the renderer.
  assert.match(preloadSource, /integrations:list/)
  assert.doesNotMatch(preloadSource, /integrations:(get-token|reveal|export)/)
  assert.doesNotMatch(mainSource, /integrations:(get-token|reveal|export)/)
  // The injection map goes to the engine, not through IPC to the window.
  assert.doesNotMatch(mainSource, /handleTrustedIpc\([^)]*injectionMap/)
})
