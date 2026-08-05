import assert from 'node:assert/strict'
import { isEngineOrigin } from '../src/main/navigation.mjs'

const origin = 'http://127.0.0.1:4317'

assert.equal(isEngineOrigin(`${origin}/console/`, origin), true)
assert.equal(isEngineOrigin(`${origin}/api/graph`, origin), true)
assert.equal(isEngineOrigin(`http://127.0.0.1:4317@attacker.example/`, origin), false)
assert.equal(isEngineOrigin('https://127.0.0.1:4317/console/', origin), false)
assert.equal(isEngineOrigin('not a URL', origin), false)

console.log('navigation test passed (exact engine origin only; trusted-window identity is covered by unit tests)')
