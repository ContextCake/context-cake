// Update awareness — a single, unauthenticated, PII-free check against a
// pinned GitHub host. Never blocks render, never retries, never throws.
//
// Privacy: the request carries no tokens, no identifiers, nothing beyond the
// implicit HTTP request (UA/IP visible to GitHub like any other fetch). The
// check is disable-able per mode (see isUpdateCheckEnabled) so the public
// demo/Pages embed stays network-silent by default.

// The monorepo publishes releases under two tag namespaces: engine `v*` and
// console `console-v*` (console-deploy.yml deploys on the latter). We list
// recent releases and pick the newest console one — `/releases/latest` would
// return whichever namespace released most recently and misreport versions.
const RELEASES_URL = 'https://api.github.com/repos/ContextCake/context-cake/releases?per_page=20'
const TAG_PREFIX = /^console-v(?=\d)/
const STORAGE_KEY = 'cc-update-check'

export interface UpdateInfo {
  latest: string
  url: string
}

// Session cache: at most one network call per page load, regardless of how
// many components ask.
let cached: UpdateInfo | null | undefined

/**
 * Compare two dotted version strings numerically, segment by segment.
 * Longer wins on a shared prefix (1.2.1 > 1.2). Non-numeric segments compare
 * as 0. Returns >0 if `a` is newer than `b`, <0 if older, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const an = Number.parseInt(as[i] ?? '0', 10) || 0
    const bn = Number.parseInt(bs[i] ?? '0', 10) || 0
    if (an !== bn) return an - bn
  }
  return 0
}

/**
 * Single unauthenticated check against a pinned host for a newer release.
 * Never throws — any network error, non-2xx status, or missing tag resolves
 * to null. Result is session-cached so repeated calls don't refetch.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (cached !== undefined) return cached

  let res: Response
  try {
    res = await fetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } })
  } catch {
    cached = null
    return null
  }
  if (!res.ok) {
    cached = null
    return null
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    cached = null
    return null
  }

  // Newest console release: releases come newest-first; skip drafts,
  // prereleases, and the engine's `v*` namespace.
  const releases = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
  const release = releases.find((r) =>
    typeof r?.tag_name === 'string' && TAG_PREFIX.test(r.tag_name) && r.draft !== true && r.prerelease !== true)
  const tag = release?.tag_name as string | undefined
  const htmlUrl = release?.html_url
  if (!tag) {
    cached = null
    return null
  }

  const latest = tag.replace(TAG_PREFIX, '')
  if (!latest || compareVersions(latest, currentVersion) <= 0) {
    cached = null
    return null
  }

  // Scheme-check the API-provided URL before it becomes a clickable href.
  const safeUrl = typeof htmlUrl === 'string' && htmlUrl.startsWith('https://') ? htmlUrl : `https://github.com/ContextCake/context-cake/releases/tag/${tag}`
  const result: UpdateInfo = { latest, url: safeUrl }
  cached = result
  return result
}

/** Test-only: reset the session cache between test cases. */
export function __resetUpdateCheckCache(): void {
  cached = undefined
}

/**
 * Whether the update check is enabled, reading localStorage key
 * `cc-update-check` ('on'/'off'). Default: on in live mode (real deployments
 * benefit from knowing about updates), off in demo mode (the public
 * Pages/demo embed stays network-silent by default).
 */
export function isUpdateCheckEnabled(mode: 'demo' | 'live'): boolean {
  if (typeof window === 'undefined') return false
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    stored = null
  }
  if (stored === 'on') return true
  if (stored === 'off') return false
  return mode === 'live'
}

export function setUpdateCheckEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // localStorage unavailable (private mode, etc.) — silently no-op.
  }
}
