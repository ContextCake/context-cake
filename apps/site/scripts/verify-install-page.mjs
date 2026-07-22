import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('../dist/install/index.html', import.meta.url), 'utf8')

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
requireText('ContextCake-0.1.0-arm64.dmg', 'Mac download must target the published DMG')
requireText('href="/install" aria-current="page"', 'Install navigation must expose the current route')
requireText('Show source installation', 'Versioned source installation must remain available')
requireText('console-v0.2.0', 'Source installation must stay pinned to the published console tag')
requireText('013525569cd3c3cdfac77d22bf1976a1d0bc6e8ffcbdcfbbaa8bd92502bc4253', 'Archive checksum must remain visible in the generated page')

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

console.log('install page verification passed (Mac activation + source fallback)')
