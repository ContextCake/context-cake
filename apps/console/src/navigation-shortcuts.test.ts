import menuSource from '../../desktop/src/main/menu.mjs?raw'
import { expect, it } from 'vitest'
import { NAVIGATION_SHORTCUTS } from './shell-navigation'

it('Settings and shell digit shortcuts agree with the native menu labels and commands', () => {
  const source = menuSource
  const native = [...source.matchAll(/label: 'Go to ([^']+)', accelerator: 'CmdOrCtrl\+([1-6])', click: \(\) => invoke\('destination:([1-6])'\)/g)]
  expect(native).toHaveLength(6)
  expect(native.map((item) => ({ key: item[2], label: item[1] })).sort((a, b) => a.key.localeCompare(b.key)))
    .toEqual(NAVIGATION_SHORTCUTS.map(({ key, label }) => ({ key, label })))
  for (const item of native) expect(item[2]).toBe(item[3])
})
