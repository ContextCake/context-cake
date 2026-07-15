import assert from 'node:assert/strict'
import { isEngineOrigin, isTrustedIpcSender } from '../src/main/navigation.mjs'

const origin = 'http://127.0.0.1:4317'

assert.equal(isEngineOrigin(`${origin}/console/`, origin), true)
assert.equal(isEngineOrigin(`${origin}/api/graph`, origin), true)
assert.equal(isEngineOrigin(`http://127.0.0.1:4317@attacker.example/`, origin), false)
assert.equal(isEngineOrigin('https://127.0.0.1:4317/console/', origin), false)
assert.equal(isEngineOrigin('not a URL', origin), false)

const trustedWebContents = { getURL: () => `${origin}/console/` }
assert.equal(isTrustedIpcSender({ sender: trustedWebContents }, trustedWebContents, origin), true)
assert.equal(isTrustedIpcSender({
  sender: trustedWebContents,
  senderFrame: { url: 'https://attacker.example/' },
}, trustedWebContents, origin), false)
assert.equal(isTrustedIpcSender({
  sender: { getURL: () => `${origin}/console/` },
}, trustedWebContents, origin), false)

console.log('navigation test passed (exact engine origin and trusted IPC sender only)')
