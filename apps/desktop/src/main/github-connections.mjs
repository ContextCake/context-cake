// The GitHub credential broker: the app's half of the manifest's `auth`
// contract.
//
// A manifest may only ever NAME a credential ("keychain:<alias>"). This module
// is what those names resolve against. It holds the secrets encrypted in
// `tokens.enc`, hands the engine a by-value map at injection time, and never
// lets a secret back out through `list()` — which is what the IPC bridge and
// the UI actually call.
//
// Two deliberate properties:
//
//   1. It is independent of accounts. Connecting GitHub requires no
//      ContextCake sign-in, because a local-first product must not make
//      reading your own private repo contingent on our servers existing. This
//      is also why the integration credential is kept distinct from the
//      Supabase sign-in identity (project-profiles design §11): revoking one
//      must never silently revoke the other.
//
//   2. Every connection records the host it was minted for. That is what makes
//      the engine's host binding enforceable — a token for github.com is
//      withheld from a layer whose apiBase points anywhere else, so a manifest
//      you did not author cannot aim your credential at a host it chose.

import { createEncryptedStorage } from './encrypted-storage.mjs'

const STORE_KEY = 'github.connections'
const STORE_FILE = 'tokens.enc'
// The manifest's own alias grammar (manifest.mjs validateAuthReference). An
// alias this module mints must be referenceable from a manifest, so it is held
// to the same charset — note ':' is absent, which is why aliases are
// "<host>/<login>" and never "github:<login>".
const ALIAS_RE = /^[A-Za-z0-9._/-]+$/

/** Normalize a user-entered host into the three forms the app needs. */
export function githubHosts(hostInput = 'github.com') {
  const raw = String(hostInput || 'github.com').trim()
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error('Enter a GitHub host such as github.com or ghe.example.com.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Enter only an HTTPS GitHub host, without credentials, a path, query, or fragment.')
  }
  // Credential aliases deliberately exclude ':'; reject a custom port before
  // verification sends the token and only then discovers it cannot be stored.
  if (url.port || url.hostname.includes(':')) {
    throw new Error('GitHub connections require a DNS host on the standard HTTPS port.')
  }
  const gitHost = url.hostname.toLowerCase() || 'github.com'
  if (gitHost === 'github.com' || gitHost === 'www.github.com') {
    return { gitHost: 'github.com', apiHost: 'api.github.com', apiBase: 'https://api.github.com' }
  }
  // GitHub Enterprise Server mounts its API under the same host.
  return { gitHost, apiHost: gitHost, apiBase: `https://${gitHost}/api/v3` }
}

export function connectionAlias(gitHost, login) {
  return `${gitHost}/${login}`
}

export function createGithubConnections({ configDir, safeStorage, now = () => new Date().toISOString() }) {
  const storage = createEncryptedStorage({ configDir, safeStorage, fileName: STORE_FILE })

  function readAll() {
    try {
      const parsed = JSON.parse(storage.getItem(STORE_KEY) ?? '{}')
      const connections = parsed?.connections
      return connections && typeof connections === 'object' && !Array.isArray(connections) ? connections : {}
    } catch {
      return {}
    }
  }

  function writeAll(connections) {
    if (Object.keys(connections).length === 0) {
      storage.removeItem(STORE_KEY)
      return
    }
    storage.setItem(STORE_KEY, JSON.stringify({ version: 1, connections }))
  }

  return {
    file: storage.file,

    /**
     * Metadata only — deliberately never the token. This is what crosses the
     * IPC bridge to the renderer, so the secret must not be in the object at
     * all rather than merely unrendered.
     */
    list() {
      return Object.entries(readAll())
        .map(([alias, c]) => ({
          alias,
          login: c.login,
          gitHost: c.gitHost,
          apiHost: c.apiHost,
          tokenType: c.tokenType,
          createdAt: c.createdAt,
        }))
        .sort((a, b) => a.alias.localeCompare(b.alias))
    },

    add({ login, token, host = 'github.com', tokenType = 'pat' }) {
      if (!login || typeof login !== 'string') throw new Error('A GitHub connection needs the account login.')
      if (!token || typeof token !== 'string') throw new Error('A GitHub connection needs a token.')
      const { gitHost, apiHost, apiBase } = githubHosts(host)
      const alias = connectionAlias(gitHost, login)
      if (!ALIAS_RE.test(alias)) throw new Error(`"${alias}" is not a usable credential alias.`)
      const connections = readAll()
      connections[alias] = { login, gitHost, apiHost, apiBase, tokenType, token, createdAt: now() }
      writeAll(connections)
      return { alias, login, gitHost, apiHost, tokenType }
    },

    remove(alias) {
      const connections = readAll()
      if (!(alias in connections)) return false
      delete connections[alias]
      writeAll(connections)
      return true
    },

    /**
     * The by-value map handed to the engine. Host-bound on purpose, and bound
     * twice because the same credential is used against two different hosts:
     * `host` is the API host the adapter talks to (api.github.com), `gitHost`
     * is the host a clone URL names (github.com). The engine checks whichever
     * applies before it offers the secret to anything.
     */
    injectionMap() {
      const out = {}
      for (const [alias, c] of Object.entries(readAll())) {
        if (typeof c?.token === 'string' && c.token) {
          out[alias] = { secret: c.token, host: c.apiHost, gitHost: c.gitHost }
        }
      }
      return out
    },

    /** Git-over-HTTPS credentials, keyed by the host a clone URL would name. */
    gitCredentialFor(gitHost) {
      for (const c of Object.values(readAll())) {
        if (c.gitHost === String(gitHost || '').toLowerCase() && c.token) {
          return { username: 'x-access-token', password: c.token, login: c.login }
        }
      }
      return null
    },

    clear() { storage.clear() },
  }
}

/**
 * Confirm a pasted token works and learn which account it belongs to, so the
 * alias reflects the real login rather than whatever the user typed. Network
 * access is injected so this is testable without reaching GitHub.
 */
export async function verifyGithubToken({ token, host = 'github.com', fetchImpl = fetch, timeoutMs = 10_000 }) {
  const { apiBase, gitHost, apiHost } = githubHosts(host)
  const res = await fetchImpl(`${apiBase}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'contextcake',
      Authorization: `Bearer ${token}`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status === 401) throw new Error('GitHub rejected that token. Check it was copied whole and has not expired.')
  if (res.status === 403) throw new Error('GitHub refused the request (rate limited, or the token lacks read access).')
  if (res.status >= 300 && res.status < 400) throw new Error('That host redirected the request; check the server address.')
  if (!res.ok) throw new Error(`GitHub returned ${res.status} while verifying the token.`)
  const body = await res.json()
  if (!body?.login) throw new Error('GitHub did not identify an account for that token.')
  return { login: body.login, gitHost, apiHost }
}
