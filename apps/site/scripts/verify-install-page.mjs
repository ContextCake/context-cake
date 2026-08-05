import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('../dist/install/index.html', import.meta.url), 'utf8')
const demoHtml = await readFile(new URL('../dist/demo/index.html', import.meta.url), 'utf8')
const desktopPackage = JSON.parse(await readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8'))
const sourceRelease = JSON.parse(await readFile(new URL('../src/data/source-release.json', import.meta.url), 'utf8'))

function requireText(text, message) {
  if (!html.includes(text)) throw new Error(message)
}

function forbidText(text, message) {
  if (html.includes(text)) throw new Error(message)
}

function requireOrder(items) {
  let previous = -1
  for (const item of items) {
    const position = html.indexOf(item)
    if (position === -1) throw new Error(`Install page is missing: ${item}`)
    if (position <= previous) throw new Error(`Install activation order is incorrect at: ${item}`)
    previous = position
  }
}

requireText('Download for Mac', 'Mac download must remain the primary install action')
requireText(`ContextCake-${desktopPackage.version}-arm64.dmg`, 'Mac download must target the current desktop version')
requireText('href="/install" aria-current="page"', 'Install navigation must expose the current route')
requireText('Show source installation', 'Versioned source installation must remain available')
requireText(`app-v${sourceRelease.version}`, 'Source installation must use an app release tag')
requireText(sourceRelease.sha256, 'Archive checksum must remain visible in the generated page')

requireOrder([
  'Add a source you already have',
  'Connect the AI client you use',
  'Ask one question and inspect the answer',
  'Need the engine without the app?',
])

forbidText('The next distribution layer', 'Planned distribution channels must not displace activation')
forbidText('After sign-in', 'Sign-in must not be presented as required for local setup')
forbidText('theagent', 'Inline link whitespace collapsed in production HTML')
forbidText('nopostinstall', 'Inline code whitespace collapsed in production HTML')

if (!demoHtml.includes('https://contextcake-console.pages.dev/')) {
  throw new Error('The site demo must embed the canonical released Web Demo')
}
if (demoHtml.includes('/demo-app/')) {
  throw new Error('The site must not ship an independently built renderer')
}
if (!demoHtml.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"')) {
  throw new Error('The cross-origin Web Demo embed must retain its iframe sandbox')
}

console.log('install page verification passed (Mac activation + source fallback)')
