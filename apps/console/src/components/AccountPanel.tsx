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
    setError('')
    clearSignInTimer()
    try {
      await bridge.signIn(provider)
      if (attempt !== signInAttempt.current) return
      signInTimer.current = setTimeout(() => {
        bridge.cancelSignIn().catch(() => {})
        setBusy(false)
        setPendingProvider(null)
        setError('Sign-in wasn’t completed. You can try again.')
      }, 10 * 60 * 1000)
    } catch (err) {
      setBusy(false)
      setPendingProvider(null)
      setError(messageOf(err))
    }
  }

  const cancelSignIn = async () => {
    signInAttempt.current += 1
    clearSignInTimer()
    await run(() => bridge.cancelSignIn())
  }

  return (
    <section className="cc-account" aria-labelledby="cc-account-title" aria-busy={busy}>
      <div className="cc-account-head">
        <span id="cc-account-title">Account</span>
        {auth.signedIn && <span className="cc-account-dot" aria-label="Signed in" />}
      </div>

      {!auth.available ? (
        <p className="cc-account-note">Sign-in isn’t configured in this build. Local features still work.</p>
      ) : auth.signedIn ? (
        <>
          <p className="cc-account-email" title={auth.email}>{auth.email ?? 'Signed in'}</p>
          <div className="cc-account-actions">
            <button type="button" disabled={busy} onClick={() => run(() => bridge.signOut())}>Sign out</button>
            <button type="button" className="cc-account-danger" disabled={busy} onClick={() => run(() => bridge.deleteAccount())}>Delete</button>
          </div>
        </>
      ) : (
        <div className="cc-account-providers">
          <button type="button" disabled={busy} onClick={() => startSignIn('github')}>
            {pendingProvider === 'github' ? 'Opening browser…' : 'Sign in with GitHub'}
          </button>
          {pendingProvider && <button type="button" onClick={cancelSignIn}>Cancel sign-in</button>}
        </div>
      )}

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
