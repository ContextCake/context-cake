import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreWindowState } from '../src/main/window-state.mjs'

const primary = { workArea: { x: 0, y: 0, width: 1512, height: 982 } }

test('window restoration centers invalid or disconnected bounds on the primary display', () => {
  assert.deepEqual(restoreWindowState(null, [primary], primary), {
    bounds: { x: 76, y: 61, width: 1360, height: 860 }, maximized: false,
  })
  assert.deepEqual(restoreWindowState({ bounds: { x: 6000, y: 200, width: 1000, height: 700 }, maximized: true }, [primary], primary), {
    bounds: { x: 256, y: 141, width: 1000, height: 700 }, maximized: true,
  })
})

test('window restoration clamps partly visible bounds into their current work area', () => {
  assert.deepEqual(restoreWindowState({ bounds: { x: -100, y: -50, width: 900, height: 600 }, maximized: false }, [primary], primary), {
    bounds: { x: 0, y: 0, width: 900, height: 600 }, maximized: false,
  })
})
