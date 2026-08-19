// The one place that knows the shape and meaning of src/config/flags.json.
// Pages reach it through src/config/flags.ts, the build scripts import it
// directly, and astro.config.mjs reads it for the sitemap filter — so the
// visibility rule and the hidden-state redirect lines exist exactly once.
import { readFile } from 'node:fs/promises'

const FLAGS_URL = new URL('../src/config/flags.json', import.meta.url)
const FLAG_KEYS = ['commerceVisible', 'paymentsLive']

// The flags file is a plain object with exactly these boolean keys. Anything
// else — a typo'd key, a "false" string, an array — is a build error naming the
// file, never a silent "hidden" or "visible".
export function assertSiteFlags(raw, source = 'src/config/flags.json') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: expected an object with keys ${FLAG_KEYS.join(', ')}`)
  }
  const keys = Object.keys(raw)
  const unknown = keys.filter((key) => !FLAG_KEYS.includes(key))
  const missing = FLAG_KEYS.filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw new Error(`${source}: unknown key(s) ${unknown.join(', ')}`)
  if (missing.length > 0) throw new Error(`${source}: missing key(s) ${missing.join(', ')}`)
  for (const key of FLAG_KEYS) {
    if (typeof raw[key] !== 'boolean') {
      throw new Error(`${source}: ${key} must be true or false, got ${JSON.stringify(raw[key])}`)
    }
  }
  return raw
}

export async function readSiteFlags() {
  let text
  try {
    text = await readFile(FLAGS_URL, 'utf8')
  } catch (error) {
    throw new Error(`src/config/flags.json: cannot read (${error?.message ?? error})`)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`src/config/flags.json: invalid JSON (${error?.message ?? error})`)
  }
  return assertSiteFlags(raw)
}

// Live payments imply visible commerce; the two are never allowed to disagree.
// Tolerates a missing/null value (treated as hidden) so callers can pass a raw
// parse result without a guard.
export function isCommerceVisible(flags) {
  if (flags === null || typeof flags !== 'object') return false
  return flags.commerceVisible === true || flags.paymentsLive === true
}

// Routes that only exist while commerce is visible, and where each one goes
// while it is hidden. Both slash forms are listed so the redirect answers
// however the path arrives.
export const HIDDEN_COMMERCE_ROUTES = [
  { path: '/pricing', to: '/' },
  { path: '/creators', to: '/packs' },
]

// The exact public/_redirects lines emitted while commerce is hidden. Used by
// the renderer that writes the file and by the verifiers that read it back.
export const HIDDEN_REDIRECT_LINES = HIDDEN_COMMERCE_ROUTES.flatMap(({ path, to }) => [
  `${path} ${to} 302`,
  `${path}/ ${to} 302`,
])

// Sitemap entries and built pages for the hidden routes are compared by
// pathname; both `/pricing` and `/pricing/` count.
export function isHiddenCommercePath(pathname) {
  return HIDDEN_COMMERCE_ROUTES.some(({ path }) => pathname === path || pathname === `${path}/`)
}
