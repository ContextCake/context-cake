import { useEffect, useRef, useState } from 'react'

type AuthState = Awaited<ReturnType<NonNullable<typeof window.__CC_AUTH>['getState']>>
type SyncState = Awaited<ReturnType<NonNullable<typeof window.__CC_AUTH>['getSyncState']>>

const SIGNED_OUT: AuthState = { available: true, signedIn: false }
const IDLE: SyncState = { status: 'idle' }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '') : 'Something went wrong.'
}

/** Desktop-only account controls. Browser/demo builds render nothing. */
export function AccountPanel() {
  const bridge = window.__CC_AUTH
  const [auth, setAuth] = useState<AuthState>(() => window.__CC_DESKTOP?.authState ?? SIGNED_OUT)
  const [sync, setSync] = useState<SyncState>(IDLE)
  const [busy, setBusy] = useState(false)
  const [pendingProvider, setPendingProvider] = useState<'github' | null>(null)
  const [error, setError] = useState('')
  const signInTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const signInAttempt = useRef(0)
  const signInPending = useRef(false)

  const clearSignInTimer = () => {
    if (signInTimer.current) clearTimeout(signInTimer.current)
    signInTimer.current = null
  }

  useEffect(() => {
    if (!bridge) return
    bridge.getState().then(setAuth).catch(() => setAuth({ available: false, signedIn: false }))
    bridge.getSyncState().then(setSync).catch(() => {})
    const removeSession = bridge.onSessionChanged((state) => {
      signInAttempt.current += 1
      signInPending.current = false
      clearSignInTimer()
      setAuth(state)
      setBusy(false)
      setPendingProvider(null)
      setError('')
    })
    const removeSync = bridge.onSyncStatus(setSync)
    const removeError = bridge.onError((message) => {
      signInAttempt.current += 1
      clearSignInTimer()
      setError(message)
      setBusy(false)
      // The main process deliberately keeps a valid pending OAuth attempt when
      // an unrelated or forged callback arrives. Keep Cancel visible so that
      // attempt can never leave the renderer stuck behind the backend lock.
    })
    return () => {
      removeSession()
      removeSync()
      removeError()
      clearSignInTimer()
      // The Account pane is intentionally unmounted when Settings closes or
      // switches panes. Do not leave the main-process OAuth lock orphaned.
      if (signInPending.current) bridge.cancelSignIn().catch(() => {})
      signInPending.current = false
    }
  }, [bridge])

  if (!bridge) return null

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setPendingProvider(null)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
      setPendingProvider(null)
    }
  }

  const startSignIn = async (provider: 'github') => {
    const attempt = ++signInAttempt.current
    setBusy(true)
    setPendingProvider(provider)
    signInPending.current = true
    setError('')
    clearSignInTimer()
    try {
      await bridge.signIn(provider)
      if (attempt !== signInAttempt.current) return
      signInTimer.current = setTimeout(() => {
        signInPending.current = false
        bridge.cancelSignIn().catch(() => {})
        setBusy(false)
        setPendingProvider(null)
        setError('Sign-in wasn’t completed. You can try again.')
      }, 10 * 60 * 1000)
    } catch (err) {
      signInPending.current = false
      setBusy(false)
      setPendingProvider(null)
      setError(messageOf(err))
    }
  }

  const cancelSignIn = async () => {
    signInAttempt.current += 1
    signInPending.current = false
    clearSignInTimer()
    await run(() => bridge.cancelSignIn())
  }

  return (
    <section className="cc-account" aria-labelledby="cc-account-title" aria-busy={busy}>
      <div className="cc-account-profile">
        <span className="cc-account-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2" /><path d="M5.8 19.5a6.2 6.2 0 0 1 12.4 0" /></svg>
        </span>
        <div className="cc-account-identity">
          <div className="cc-account-head">
            <span id="cc-account-title">ContextCake account</span>
            {auth.signedIn && <span className="cc-account-dot" aria-label="Signed in" />}
          </div>
          {!auth.available ? (
            <p className="cc-account-note">Sign-in isn’t configured in this build. Local features still work.</p>
          ) : auth.signedIn ? (
            <p className="cc-account-email" title={auth.email}>{auth.email ?? 'Signed in'}</p>
          ) : (
            <p className="cc-account-note">Optional. Sign in to sync preferences and source metadata across your Macs.</p>
          )}
        </div>
      </div>

      {auth.available && (auth.signedIn ? (
        <>
          <div className="cc-account-actions">
            <button type="button" disabled={busy} onClick={() => run(() => bridge.signOut())}>Sign out</button>
            <button type="button" className="cc-account-danger" disabled={busy} onClick={() => run(() => bridge.deleteAccount())}>Delete account</button>
          </div>
        </>
      ) : (
        <div className="cc-account-providers">
          <button type="button" disabled={busy} onClick={() => startSignIn('github')}>
            {pendingProvider === 'github' ? 'Opening browser…' : 'Sign in with GitHub'}
          </button>
          {pendingProvider && <button type="button" onClick={cancelSignIn}>Cancel sign-in</button>}
        </div>
      ))}

      {auth.signedIn && sync.status === 'syncing' && <p className="cc-account-status">Syncing settings…</p>}
      {auth.signedIn && sync.status === 'synced' && (
        <p className="cc-account-status">{sync.overwritten ? 'Settings updated from another Mac.' : 'Settings synced.'}</p>
      )}
      {auth.signedIn && sync.status === 'error' && <p className="cc-account-error" role="status">{sync.message}</p>}
      {!auth.signedIn && auth.notice && <p className="cc-account-note" role="status">{auth.notice}</p>}
      {error && <p className="cc-account-error" role="alert">{error}</p>}
    </section>
  )
}
