import { readFile } from 'node:fs/promises'
import { HIDDEN_COMMERCE_ROUTES, HIDDEN_REDIRECT_LINES, isCommerceVisible, readSiteFlags } from './site-flags.mjs'

const html = await readFile(new URL('../dist/install/index.html', import.meta.url), 'utf8')
const homeHtml = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
const pricingHtml = await readFile(new URL('../dist/pricing/index.html', import.meta.url), 'utf8')
const demoHtml = await readFile(new URL('../dist/demo/index.html', import.meta.url), 'utf8')
const installationDocsHtml = await readFile(new URL('../dist/docs/getting-started/installation/index.html', import.meta.url), 'utf8')
const diagnosticsDocsHtml = await readFile(new URL('../dist/docs/guides/diagnostics/index.html', import.meta.url), 'utf8')
const appRelease = JSON.parse(await readFile(new URL('../src/data/app-release.json', import.meta.url), 'utf8'))
const sourceRelease = JSON.parse(await readFile(new URL('../src/data/source-release.json', import.meta.url), 'utf8'))
const redirects = await readFile(new URL('../dist/_redirects', import.meta.url), 'utf8')
const commerceVisible = isCommerceVisible(await readSiteFlags())

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
requireText(appRelease.tag, 'Install page must identify the published Mac release')
requireText('href="/download/mac"', 'Install page must use the stable Mac download route')
requireText('href="/install" aria-current="page"', 'Install navigation must expose the current route')
requireText('Show source installation', 'Versioned source installation must remain available')
requireText(`app-v${sourceRelease.version}`, 'Source installation must use an app release tag')
requireText(sourceRelease.sha256, 'Archive checksum must remain visible in the generated page')
requireText('apps/playground/manifest.json', 'Source install must use the current monorepo demo path')
if (!installationDocsHtml.includes(`app-v${sourceRelease.version}`)) {
  throw new Error('Installation docs must identify the verified source release')
}
if (!installationDocsHtml.includes(sourceRelease.sha256)) {
  throw new Error('Installation docs must include the verified source archive checksum')
}
if (!installationDocsHtml.includes('apps/playground/manifest.json')) {
  throw new Error('Installation docs must use the current monorepo demo path')
}

for (const [label, page] of [['home', homeHtml], ['diagnostics docs', diagnosticsDocsHtml]]) {
  if (page.includes('until that signed download appears')) {
    throw new Error(`${label} must not describe shipped diagnostics as unreleased`)
  }
}

const appParts = appRelease.version.split('.').map(Number)
const sourceParts = sourceRelease.version.split('.').map(Number)
if (appParts.length !== 3 || sourceParts.length !== 3 || [...appParts, ...sourceParts].some((part) => !Number.isSafeInteger(part) || part < 0)) {
  throw new Error('App and source releases must use numeric X.Y.Z versions')
}
if (sourceParts[0] !== appParts[0] || sourceParts[1] < appParts[1] - 1 || sourceParts[1] > appParts[1] || (sourceParts[1] === appParts[1] && sourceParts[2] > appParts[2])) {
  throw new Error(`Verified source release ${sourceRelease.version} has drifted from app release ${appRelease.version}`)
}

requireOrder([
  'Choose a folder with Markdown files',
  'Connect your AI tool',
  'Run the test prompt',
  'Run the source version on Intel Mac, Linux, or WSL.',
])

forbidText('The next distribution layer', 'Planned distribution channels must not displace activation')
forbidText('After sign-in', 'Sign-in must not be presented as required for local setup')
forbidText('theagent', 'Inline link whitespace collapsed in production HTML')
forbidText('nopostinstall', 'Inline code whitespace collapsed in production HTML')

// The pricing page carries a Mac download only while it is a real page. While
// commerce is hidden it is a redirect stub and is checked as one below.
const downloadPages = [['home', homeHtml], ['install', html]]
if (commerceVisible) downloadPages.push(['pricing', pricingHtml])
for (const [label, page] of downloadPages) {
  if (!page.includes('href="/download/mac"')) throw new Error(`${label} page must use the stable Mac download route`)
  if (/href="https:\/\/github\.com\/ContextCake\/context-cake\/releases\/download\/app-v[^\"]+ContextCake-[^\"]+-arm64\.dmg"/.test(page)) {
    throw new Error(`${label} page must not embed a versioned GitHub DMG URL`)
  }
}
if (!homeHtml.includes('Download for Mac')) throw new Error('Homepage Mac action must name the platform')
if (commerceVisible && !pricingHtml.includes('Download for Mac')) throw new Error('Pricing Mac action must name the platform')
if (!redirects.includes(`/download/mac ${appRelease.artifacts.dmg.url} 302`)) {
  throw new Error('Stable Mac redirect must target the published DMG')
}

if (!commerceVisible) {
  // Astro prerenders an `Astro.redirect()` route as a meta-refresh stub (a
  // 0-second refresh — the pages pass 301 for exactly that); the _redirects
  // lines make Cloudflare answer 302 before that stub is served.
  for (const { path, to } of HIDDEN_COMMERCE_ROUTES) {
    const stub = await readFile(new URL(`../dist${path}/index.html`, import.meta.url), 'utf8')
    if (!stub.includes('http-equiv="refresh"')) {
      throw new Error(`${path} must build as a redirect stub while commerce is hidden`)
    }
    if (!stub.includes(`content="0;url=${to}"`)) {
      throw new Error(`${path} stub must refresh immediately to ${to} (Astro.redirect('${to}', 301))`)
    }
  }
  for (const line of HIDDEN_REDIRECT_LINES) {
    if (!redirects.includes(line)) {
      throw new Error(`_redirects must contain "${line}" while commerce is hidden — it is rendered from the flags by prebuild; run \`npm run build\` (or \`npm run render-redirects\`)`)
    }
  }
} else {
  for (const line of HIDDEN_REDIRECT_LINES) {
    if (redirects.includes(line)) {
      throw new Error(`_redirects must not contain "${line}" while commerce is visible — it is rendered from the flags by prebuild; run \`npm run build\` (or \`npm run render-redirects\`)`)
    }
  }
}

const demoIframeMatch = demoHtml.match(/<iframe\b[^>]*\bsrc="([^"]+)"[^>]*>/i)
if (!demoIframeMatch) throw new Error('The site demo must contain a Web Demo iframe')

let embeddedDemoUrl
try {
  embeddedDemoUrl = new URL(demoIframeMatch[1])
} catch {
  throw new Error('The site demo iframe must use a valid URL')
}
if (embeddedDemoUrl.href !== 'https://contextcake-console.pages.dev/') {
  throw new Error('The site demo must embed the canonical released Web Demo')
}
if (demoHtml.includes('/demo-app/')) {
  throw new Error('The site must not ship an independently built renderer')
}
if (!demoHtml.includes('sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"')) {
  throw new Error('The cross-origin Web Demo embed must retain its iframe sandbox')
}

const [appMajor = 0, appMinor = 0] = appRelease.version.split('.').map(Number)
const releaseHasDiagnosticsDemo = appMajor > 0 || appMinor >= 9
const diagnosticsDemoCues = [
  'choose Diagnostics to inspect',
  'Diagnostics are explicitly labeled sample data',
  'Inspect engine diagnostics',
]
for (const cue of diagnosticsDemoCues) {
  if (demoHtml.includes(cue) !== releaseHasDiagnosticsDemo) {
    throw new Error(
      `Demo copy must ${releaseHasDiagnosticsDemo ? 'describe' : 'withhold'} the diagnostics experience for app release ${appRelease.version}: ${cue}`,
    )
  }
}

console.log(`install page verification passed (published Mac release + source fallback; commerce ${commerceVisible ? 'visible' : 'hidden'})`)
