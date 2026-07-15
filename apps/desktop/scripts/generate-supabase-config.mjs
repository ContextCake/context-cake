import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPublicSupabaseKey } from '../src/main/supabase-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const output = process.env.CC_SUPABASE_CONFIG_OUT || path.join(here, '..', 'build', 'supabase-config.json')
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

if (!url || !anonKey) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required to package the desktop app.')
}
if (!isPublicSupabaseKey(anonKey)) {
  throw new Error('SUPABASE_ANON_KEY must be a publishable key or a legacy anon JWT; privileged keys cannot be packaged.')
}

let parsed
try { parsed = new URL(url) } catch { /* handled below */ }
if (parsed?.protocol !== 'https:') throw new Error('SUPABASE_URL must be a valid HTTPS URL.')

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify({ url: parsed.toString().replace(/\/$/, ''), anonKey }, null, 2)}\n`, { mode: 0o600 })
console.log(`Wrote ${output}`)
