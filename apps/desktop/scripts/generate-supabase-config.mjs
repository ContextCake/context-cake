// Writes the packaged Supabase configuration — or, by default, a marker saying
// accounts are not shipped in this build.
//
// Accounts are off unless CC_ACCOUNTS=1. The hosted account system exists and
// works, but everything it can safely sync is scrubbed of paths, commands and
// secrets before upload, so what actually crosses machines is a preference blob
// and a set of profile shapes with holes in them. That is not worth a hosted
// Postgres holding user rows in a product whose claim is that context stays on
// your machine. See docs/release-gates.md.
//
// The file is always written: electron-builder's extraResources entry treats a
// missing source as a build failure, and "accounts are off" is a state the app
// must be able to read rather than infer from an absent file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPublicSupabaseKey } from '../src/main/supabase-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const output = process.env.CC_SUPABASE_CONFIG_OUT || path.join(here, '..', 'build', 'supabase-config.json')

function write(config) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

if (process.env.CC_ACCOUNTS !== '1') {
  write({ accounts: 'disabled' })
  console.log(`Wrote ${output} (accounts disabled — set CC_ACCOUNTS=1 to package sign-in)`)
  process.exit(0)
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

if (!url || !anonKey) {
  throw new Error('CC_ACCOUNTS=1 requires SUPABASE_URL and SUPABASE_ANON_KEY to package the desktop app.')
}
if (!isPublicSupabaseKey(anonKey)) {
  throw new Error('SUPABASE_ANON_KEY must be a publishable key or a legacy anon JWT; privileged keys cannot be packaged.')
}

let parsed
try { parsed = new URL(url) } catch { /* handled below */ }
if (parsed?.protocol !== 'https:') throw new Error('SUPABASE_URL must be a valid HTTPS URL.')

write({ accounts: 'enabled', url: parsed.toString().replace(/\/$/, ''), anonKey })
console.log(`Wrote ${output} (accounts enabled)`)
