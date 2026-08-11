import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createTrustedWindowRegistry, TRUSTED_IPC_ROLES, trustedRolesForChannel } from '../src/main/trusted-windows.mjs'

function fakeWindow(id, url = 'http://127.0.0.1:4317/console/') {
  const contents = new EventEmitter()
  contents.id = id
  contents.mainFrame = { url }
  contents.getURL = () => url
  contents.isDestroyed = () => false
  contents.sent = []
  contents.send = (...args) => contents.sent.push(args)
  const window = new EventEmitter()
  window.webContents = contents
  window.isDestroyed = () => false
  return window
}

function eventFor(window, frame = window.webContents.mainFrame) {
  return { sender: window.webContents, senderFrame: frame }
}

test('trusted windows require exact identity, origin, main frame, and an allowed role', () => {
  const registry = createTrustedWindowRegistry(() => 'http://127.0.0.1:4317')
  const main = fakeWindow(1)
  const settings = fakeWindow(2, 'http://127.0.0.1:4317/console/?surface=settings')
  registry.register(main, 'main')
  registry.register(settings, 'settings')

  assert.equal(registry.resolve(eventFor(main), ['main']).role, 'main')
  assert.equal(registry.resolve(eventFor(settings), ['settings']).role, 'settings')
  assert.throws(() => registry.resolve(eventFor(settings), ['main']), /Untrusted IPC sender/)

  const impostor = fakeWindow(3)
  assert.throws(() => registry.resolve(eventFor(impostor), ['main']), /Untrusted IPC sender/)
  assert.throws(() => registry.resolve({ sender: main.webContents, senderFrame: { url: main.webContents.getURL() } }, ['main']), /Untrusted IPC sender/)
  const hostile = fakeWindow(4, 'https://attacker.example/console/')
  registry.register(hostile, 'main')
  assert.throws(() => registry.resolve(eventFor(hostile), ['main']), /Untrusted IPC sender/)
})

test('broadcast reaches live registered roles and destruction removes trust', () => {
  const registry = createTrustedWindowRegistry(() => 'http://127.0.0.1:4317')
  const main = fakeWindow(1)
  const settings = fakeWindow(2)
  registry.register(main, 'main')
  registry.register(settings, 'settings')
  registry.broadcast('preferences:changed', { theme: 'dark' })
  assert.deepEqual(main.webContents.sent, [['preferences:changed', { theme: 'dark' }]])
  assert.deepEqual(settings.webContents.sent, [['preferences:changed', { theme: 'dark' }]])

  settings.webContents.emit('destroyed')
  assert.equal(registry.size(), 1)
  assert.throws(() => registry.resolve(eventFor(settings), ['settings']), /Untrusted IPC sender/)
})

test('every native IPC capability has an explicit least-privilege window policy', () => {
  assert.deepEqual(TRUSTED_IPC_ROLES['contextcake:choose-folder'], ['main'])
  assert.deepEqual(TRUSTED_IPC_ROLES['contextcake:cli-install'], ['main'])
  assert.deepEqual(TRUSTED_IPC_ROLES['windows:open-settings'], ['main'])
  assert.deepEqual(TRUSTED_IPC_ROLES['data:reload-requested'], ['settings'])
  assert.deepEqual(TRUSTED_IPC_ROLES['contextcake:engine-relaunch'], ['main'])
  assert.deepEqual(TRUSTED_IPC_ROLES['contextcake:get-api-token'], ['main', 'settings'])
  assert.deepEqual(TRUSTED_IPC_ROLES['auth:delete-account'], ['main', 'settings'])
  assert.deepEqual(TRUSTED_IPC_ROLES['updates:get-status'], ['main', 'settings'])
  assert.deepEqual(TRUSTED_IPC_ROLES['updates:check'], ['main', 'settings'])
  assert.deepEqual(TRUSTED_IPC_ROLES['updates:install'], ['main', 'settings'])
  assert.throws(() => trustedRolesForChannel('arbitrary:invoke'), /No trusted-window policy/)
})
