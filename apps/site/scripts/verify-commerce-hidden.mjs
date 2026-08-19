#!/usr/bin/env node
// Postbuild gate: while commerce is hidden (src/config/flags.json), no built page
// may carry a price, plan, or creator-program string, and no sitemap may list
// /pricing or /creators. Runs after verify-install-page.mjs and does nothing
// when commerce is visible.
//
// Exemptions, each deliberate:
// - Any element carrying `data-verify-exempt="<name>"` is removed before the
//   scan, up to its own closing tag (fail-closed: an unclosed one throws). Today
//   that is the pack explorer's file container in PackExplorer.astro — a Pack's
//   own files are inlined there and legitimately contain dollar amounts and
//   words like "subscription ledger". Everything around it (section headings,
//   the explorer's own copy) stays in scope.
// - /changelog renders GitHub release notes fetched at build time, so its body
//   is not something a source edit can fix; only the site's own link/nav
//   patterns are checked there.
//
// The pure pieces are exported for scripts/tests/verify-commerce-hidden.test.mjs.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, sep } from 'node:path'
import { isCommerceVisible, isHiddenCommercePath, readSiteFlags } from './site-flags.mjs'

// Site chrome and links: checked on every page, release notes included.
export const LINK_PATTERNS = [
  /href="\/pricing/,
  /href="\/creators/,
  />Pricing</,
]

// Copy that only the site's own source can produce. Each pattern names one way
// a commerce surface has leaked in the past or could. Deliberately NOT matched:
// bare `subscription|billing|payment|checkout|license|paid` — `git checkout`,
// the `billing-api` demo data, and the MIT license are all fine.
//
// Two patterns are wider than their intent and worth knowing about:
// - `/\$\d/` also matches a shell sample such as `echo $1` in the docs. None
//   exists today; if one is added, wrap it in an element with
//   `data-verify-exempt` rather than loosening the pattern.
// - `/Coming soon/` also matches a catalog entry whose `status` (data/commerce.ts)
//   is literally "Coming soon". That is on purpose: a "coming soon" Pack while
//   commerce is hidden is the vaporware read this gate exists to prevent.
export const COPY_PATTERNS = [
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

export const RELEASE_NOTES_PAGES = new Set(['changelog/index.html'])

const EXEMPT_ATTR = 'data-verify-exempt="'

// Remove every `data-verify-exempt` element, opening tag through its own closing
// tag, tracking nesting of the same tag name so a container full of nested
// <div>s is cut exactly once. Throws when the element never closes.
export function stripExempt(html, file = '<html>') {
  let out = html
  let searchFrom = 0
  for (;;) {
    const attrAt = out.indexOf(EXEMPT_ATTR, searchFrom)
    if (attrAt === -1) return out
    const nameEnd = out.indexOf('"', attrAt + EXEMPT_ATTR.length)
    const name = nameEnd === -1 ? '?' : out.slice(attrAt + EXEMPT_ATTR.length, nameEnd)
    const open = out.lastIndexOf('<', attrAt)
    const tagMatch = open === -1 ? null : /^<([a-zA-Z][\w-]*)/.exec(out.slice(open, attrAt))
    if (!tagMatch) throw new Error(`${file}: data-verify-exempt="${name}" is not inside an opening tag`)
    const tag = tagMatch[1]
    const openEnd = out.indexOf('>', attrAt)
    if (openEnd === -1) throw new Error(`${file}: data-verify-exempt="${name}" opening tag never ends`)
    const openRe = new RegExp(`<${tag}(?=[\\s>/])`, 'gi')
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')
    let depth = 1
    let cursor = openEnd + 1
    while (depth > 0) {
      openRe.lastIndex = cursor
      closeRe.lastIndex = cursor
      const nextOpen = openRe.exec(out)
      const nextClose = closeRe.exec(out)
      if (!nextClose) {
        throw new Error(`${file}: data-verify-exempt="${name}" <${tag}> never closes; the exempt region must be a complete element`)
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1
        cursor = nextOpen.index + nextOpen[0].length
      } else {
        depth -= 1
        cursor = nextClose.index + nextClose[0].length
      }
    }
    out = out.slice(0, open) + out.slice(cursor)
    searchFrom = open
  }
}

// A second view of the page with the common ways a string hides from a literal
// match undone: `$` as an entity, `<`/`>`/`"` as entities, percent-encoded
// hrefs and mailto subjects. `&amp;` is decoded last so it cannot manufacture an
// entity that then decodes again — the browser would not have either.
export function normalizeEncodings(html) {
  return html
    .replace(/&#0*36;|&#x0*24;|&dollar;/gi, () => '$')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, () => '>')
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, () => '<')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, () => '"')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, () => ' ')
    .replace(/%[0-9a-f]{2}/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence)
      } catch {
        return sequence
      }
    })
    .replace(/&amp;/g, () => '&')
}

function describe(rel, pattern, text, match, note) {
  const at = match.index
  const context = text.slice(Math.max(0, at - 40), at + match[0].length + 40).replace(/\s+/g, ' ')
  return `${rel}: ${pattern}${note ? ` ${note}` : ''} near "${context}"`
}

// Scan one built page. `rel` is the dist-relative path with forward slashes.
export function scanHtml(html, rel) {
  const stripped = stripExempt(html, rel)
  const patterns = RELEASE_NOTES_PAGES.has(rel) ? LINK_PATTERNS : [...LINK_PATTERNS, ...COPY_PATTERNS]
  const views = [
    ['', stripped],
    ['(after decoding entities/percent-escapes)', normalizeEncodings(stripped)],
  ]
  const failures = []
  for (const pattern of patterns) {
    for (const [note, text] of views) {
      const match = pattern.exec(text)
      if (!match) continue
      failures.push(describe(rel, pattern, text, match, note))
      break
    }
  }
  return failures
}

// Scan one sitemap file: no <loc> may point at a hidden commerce route.
export function scanSitemap(xml, rel) {
  const failures = []
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    let pathname
    try {
      pathname = new URL(match[1]).pathname
    } catch {
      continue
    }
    if (isHiddenCommercePath(pathname)) failures.push(`${rel}: lists ${match[1]} while commerce is hidden`)
  }
  return failures
}

async function walkHtml(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkHtml(full, out)
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

export async function verifyDist(distRoot) {
  const files = await walkHtml(distRoot)
  if (files.length === 0) throw new Error('dist/ has no HTML files; run the build first')
  const failures = []
  for (const file of files) {
    const rel = relative(distRoot, file).split(sep).join('/')
    failures.push(...scanHtml(await readFile(file, 'utf8'), rel))
  }
  const sitemaps = (await readdir(distRoot)).filter((name) => /^sitemap.*\.xml$/.test(name))
  for (const name of sitemaps) {
    failures.push(...scanSitemap(await readFile(join(distRoot, name), 'utf8'), name))
  }
  return { pages: files.length, sitemaps: sitemaps.length, failures }
}

async function main() {
  if (isCommerceVisible(await readSiteFlags())) {
    console.log('commerce is visible; hidden-commerce verification skipped')
    return
  }
  const distRoot = fileURLToPath(new URL('../dist/', import.meta.url))
  const { pages, sitemaps, failures } = await verifyDist(distRoot)
  if (failures.length > 0) {
    console.error(`commerce is hidden but ${failures.length} built page/pattern combination(s) still leak it:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`hidden-commerce verification passed (${pages} pages, ${sitemaps} sitemap file(s), ${LINK_PATTERNS.length + COPY_PATTERNS.length} patterns)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
