// Postbuild gate: while commerce is hidden (src/config/flags.json), no built page
// may carry a price, plan, or creator-program string. Runs after
// verify-install-page.mjs and exits 0 immediately when commerce is visible.
//
// Two regions are excluded on purpose:
// - The pack explorer inlines a Pack's own files into its page, and that content
//   legitimately contains dollar amounts and words like "subscription ledger".
//   The region from `<section id="explorer"` (PackProductPage.astro) up to the
//   availability section that follows it (`<section id="availability"`, the
//   `availability.id` each Pack page passes in) is stripped before the scan. If
//   either marker moves, move this strip with it.
// - /changelog renders GitHub release notes fetched at build time, so its body is
//   not something a source edit can fix; only the site's own link/nav patterns
//   are checked there.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { isCommerceVisible, readSiteFlags } from './site-flags.mjs'

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url))

if (isCommerceVisible(await readSiteFlags())) {
  console.log('commerce is visible; hidden-commerce verification skipped')
  process.exit(0)
}

// Site chrome and links: checked on every page, release notes included.
const linkPatterns = [
  /href="\/pricing/,
  /href="\/creators/,
  />Pricing</,
]

// Copy that only the site's own source can produce. Each pattern names one way
// a commerce surface has leaked in the past or could. Deliberately NOT matched:
// bare `subscription|billing|payment|checkout|license|paid` — `git checkout`,
// the `billing-api` demo data, and the MIT license are all fine.
const copyPatterns = [
  /\$\d/,
  /Pro is never required/,
  /ContextCake Pro\b/,
  /See app pricing/,
  /See free and paid plans/,
  /verified purchases/,
  /Coming soon/,
  /Buy personal|Buy for a team|Add updates/,
  /lemonsqueezy/i,
  /founding creator/i,
  /revenue share/i,
  /payout/i,
  /Target license/,
  /License \/ target/,
  /sold separately/,
  /Free-tier/,
  /no account or subscription/,
  /What becomes paid later/,
  /Do I need ContextCake Pro/,
]

const RELEASE_NOTES_PAGES = new Set(['changelog/index.html'])
const EXPLORER_START = '<section id="explorer"'
const EXPLORER_END = '<section id="availability"'

function stripExplorer(html, file) {
  const start = html.indexOf(EXPLORER_START)
  if (start === -1) return html
  const end = html.indexOf(EXPLORER_END, start)
  if (end === -1) {
    throw new Error(`${file}: has an explorer section but no availability section after it; update verify-commerce-hidden.mjs`)
  }
  return html.slice(0, start) + html.slice(end)
}

async function walkHtml(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkHtml(full, out)
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

const files = await walkHtml(distRoot)
if (files.length === 0) throw new Error('dist/ has no HTML files; run the build first')

const failures = []
for (const file of files) {
  const rel = relative(distRoot, file)
  const html = stripExplorer(await readFile(file, 'utf8'), rel)
  const patterns = RELEASE_NOTES_PAGES.has(rel) ? linkPatterns : [...linkPatterns, ...copyPatterns]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (!match) continue
    const at = match.index
    const context = html.slice(Math.max(0, at - 40), at + match[0].length + 40).replace(/\s+/g, ' ')
    failures.push(`${rel}: ${pattern} near "${context}"`)
  }
}

if (failures.length > 0) {
  console.error(`commerce is hidden but ${failures.length} built page/pattern combination(s) still leak it:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`hidden-commerce verification passed (${files.length} pages, ${linkPatterns.length + copyPatterns.length} patterns)`)
