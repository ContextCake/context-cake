import fs from 'node:fs'
import path from 'node:path'

/** Public desktop builds may contain only publishable keys or legacy anon JWTs. */
export function isPublicSupabaseKey(value) {
  if (typeof value !== 'string') return false
  const key = value.trim()
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true
  if (key.startsWith('sb_secret_')) return false

  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload?.role === 'anon'
  } catch {
    return false
  }
}

const UNCONFIGURED = { url: '', anonKey: '' }

/**
 * Resolve public Supabase project credentials without baking secrets into the
 * repository. Packaged builds may provision supabase.json in userData; local
 * development uses SUPABASE_* (with VITE_* accepted for the shared dev env).
 *
 * A packaged build that declares `accounts: "disabled"` stays disabled no
 * matter what else is set. That marker is a statement about the artifact users
 * downloaded, so it has to outrank the environment — otherwise a stale
 * VITE_SUPABASE_* left in a shell silently re-enables sign-in in a build that
 * was published without it. Development is unaffected: `npm run dev` never
 * generates a packaged config, so env resolution still applies there.
 */
export function loadSupabaseConfig(configDir, env = process.env, packagedConfigPath = '') {
  let packaged = {}
  let user = {}
  try {
    if (packagedConfigPath) packaged = JSON.parse(fs.readFileSync(packagedConfigPath, 'utf8'))
  } catch { /* an unconfigured build remains fully usable locally */ }
  if (packaged.accounts === 'disabled') return UNCONFIGURED
  try {
    user = JSON.parse(fs.readFileSync(path.join(configDir, 'supabase.json'), 'utf8'))
  } catch { /* an unconfigured build remains fully usable locally */ }

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || user.url || packaged.url
  const rawKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || user.anonKey || packaged.anonKey
  const anonKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!url || !anonKey) return { url: '', anonKey: '' }
  if (!isPublicSupabaseKey(anonKey)) return { url: '', anonKey: '' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return { url: '', anonKey: '' }
  } catch {
    return UNCONFIGURED
  }
  return { url, anonKey }
}
