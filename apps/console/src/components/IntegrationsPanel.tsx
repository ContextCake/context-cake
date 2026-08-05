import { useCallback, useEffect, useState } from 'react'

// Connected accounts for private sources.
//
// Two honesty requirements shape this pane. First, a token pasted here is
// verified against GitHub before it is stored, so a typo says so immediately
// instead of becoming a layer that silently reads as empty a week later.
// Second, disconnecting only forgets the token locally — it cannot revoke it —
// so the UI says that and links to where revocation actually happens.

const REVOKE_URL = 'https://github.com/settings/tokens'
const TOKEN_HELP = 'https://github.com/settings/personal-access-tokens/new'

const messageOf = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong.')

export function IntegrationsPanel() {
  const bridge = window.__CC_INTEGRATIONS
  const [connections, setConnections] = useState<GithubConnection[] | null>(null)
  const [token, setToken] = useState('')
  const [host, setHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      setConnections(await bridge.list())
    } catch (err) {
      setError(messageOf(err))
    }
  }, [bridge])

  useEffect(() => { void refresh() }, [refresh])

  if (!bridge) {
    return (
      <section className="cc-account">
        <p className="cc-account-note">
          Connecting a GitHub account is available in the ContextCake Mac app, where credentials
          are stored in a file encrypted with the system keychain when encryption is available.
        </p>
      </section>
    )
  }

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const added = await bridge.addToken(token.trim(), host.trim() || undefined)
      setToken('')
      setHost('')
      setNotice(`Connected as ${added.login}. Use "keychain:${added.alias}" as a source credential.`)
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (alias: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await bridge.disconnect(alias)
      setNotice('Disconnected on this Mac. The token still exists on GitHub until you revoke it there.')
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="cc-account" aria-labelledby="cc-integrations-title" aria-busy={busy}>
      <div className="cc-account-profile">
        <span className="cc-account-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.9.1-.7.4-1.1.7-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z" /></svg>
        </span>
        <div className="cc-account-identity">
          <div className="cc-account-head">
            <span id="cc-integrations-title">GitHub</span>
            {connections && connections.length > 0 && <span className="cc-account-dot" aria-label="Connected" />}
          </div>
          <p className="cc-account-note">
            Connect an account to read private repositories as context sources. This is separate
            from signing in to ContextCake. The token stays on this Mac in a keychain-encrypted
            local file, or in memory for the current run when encryption is unavailable.
          </p>
        </div>
      </div>

      {connections && connections.length > 0 && (
        <div className="cc-settings-group">
          {connections.map((c) => (
            <div className="cc-settings-row" key={c.alias}>
              <div>
                <strong>{c.login}</strong>
                <span>{c.gitHost} · added {new Date(c.createdAt).toLocaleDateString()} · <code>keychain:{c.alias}</code></span>
              </div>
              <button type="button" disabled={busy} onClick={() => void disconnect(c.alias)}>Disconnect</button>
            </div>
          ))}
        </div>
      )}

      <form className="cc-settings-group" onSubmit={connect}>
        <div className="cc-settings-row">
          <div>
            <strong>Add a token</strong>
            <span>
              A fine-grained personal access token with read-only Contents access.{' '}
              <a href={TOKEN_HELP} target="_blank" rel="noreferrer noopener">Create one on GitHub</a>.
            </span>
          </div>
        </div>
        <div className="cc-settings-row">
          <label className="sr-only" htmlFor="cc-gh-token">GitHub token</label>
          <input
            id="cc-gh-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_… or ghp_…"
            value={token}
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="cc-settings-row">
          <label className="sr-only" htmlFor="cc-gh-host">GitHub host</label>
          <input
            id="cc-gh-host"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="github.com (or your Enterprise server)"
            value={host}
            disabled={busy}
            onChange={(e) => setHost(e.target.value)}
          />
          <button type="submit" disabled={busy || !token.trim()}>
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </div>
      </form>

      {notice && <p className="cc-account-status" role="status">{notice}</p>}
      {error && <p className="cc-account-error" role="alert">{error}</p>}
      {connections && connections.length > 0 && (
        <p className="cc-account-note">
          Disconnecting forgets the token here; it stays valid until you{' '}
          <a href={REVOKE_URL} target="_blank" rel="noreferrer noopener">revoke it on GitHub</a>.
        </p>
      )}
    </section>
  )
}
