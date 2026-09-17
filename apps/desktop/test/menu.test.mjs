import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

// menu.mjs imports electron, the updater, and the CLI installer at load. The
// template itself needs none of them, so stub all three.
const stub = `data:text/javascript,${encodeURIComponent(`
  export const app = { name: 'ContextCake', isPackaged: true }
  export const Menu = { buildFromTemplate: (template) => template }
  export const shell = { openExternal() {} }
  export const checkInteractive = () => {}
  export const installCli = () => {}
`)}`
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron' || (context.parentURL?.endsWith('/menu.mjs') && (specifier === './updater.mjs' || specifier === './cli-install.mjs'))) {
      return { url: ${JSON.stringify(stub)}, shortCircuit: true }
    }
    return next(specifier, context)
  }
`)}`)

const { menuTemplate } = await import('../src/main/menu.mjs')

function labels(menu) {
  return menu.submenu.filter((item) => item.type !== 'separator').map((item) => item.label ?? item.role)
}

function build(platform) {
  const calls = []
  const template = menuTemplate({
    platform,
    isPackaged: true,
    appName: 'ContextCake',
    getWindow: () => 'window',
    openSettings: () => calls.push('settings'),
    checkForUpdates: (window) => calls.push(`updates:${window}`),
    installCommandLineTool: (window) => calls.push(`cli:${window}`),
    openExternal: (url) => calls.push(url),
  })
  return { template, calls }
}

test('macOS keeps the app menu with settings, updates, the CLI, and quit', () => {
  const { template } = build('darwin')
  assert.equal(template[0].label, 'ContextCake')
  assert.deepEqual(labels(template[0]), ['about', 'Settings…', 'Check for Updates…', 'Install Command Line Tool…', 'hide', 'hideOthers', 'unhide', 'quit'])
  assert.equal(template.find((menu) => menu.label === 'File'), undefined)
  assert.deepEqual(labels(template.at(-1)), ['ContextCake Documentation', 'Report an Issue'])
})

test('Linux has File (Settings, Quit) and Help (About, updates, CLI), and no app menu', () => {
  const { template, calls } = build('linux')
  assert.equal(template.find((menu) => menu.label === 'ContextCake'), undefined)
  const file = template[0]
  assert.equal(file.label, 'File')
  assert.deepEqual(labels(file), ['Settings…', 'quit'])
  assert.equal(file.submenu[0].accelerator, 'CmdOrCtrl+,')

  const help = template.at(-1)
  assert.equal(help.role, 'help')
  assert.deepEqual(labels(help), ['ContextCake Documentation', 'Report an Issue', 'Check for Updates…', 'Install Command Line Tool…', 'about'])
  // No macOS-only roles leak into the Linux menu.
  const roles = template.flatMap((menu) => (menu.submenu ?? []).map((item) => item.role)).filter(Boolean)
  for (const role of ['hide', 'hideOthers', 'unhide']) assert.ok(!roles.includes(role), role)

  file.submenu[0].click()
  help.submenu.find((item) => item.label === 'Check for Updates…').click()
  help.submenu.find((item) => item.label === 'Install Command Line Tool…').click()
  assert.deepEqual(calls, ['settings', 'updates:window', 'cli:window'])
})

test('both menus keep the same View shortcuts', () => {
  const view = (platform) => build(platform).template.find((menu) => menu.label === 'View').submenu.map((item) => item.accelerator)
  assert.deepEqual(view('linux'), view('darwin'))
})
