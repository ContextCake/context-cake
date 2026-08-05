import { useEffect, useRef, useState } from 'react'
import { Button, InlineNotice, StatusBadge } from './ui'

type AuthState = Awaited<ReturnType<NonNullable<typeof window.__CC_AUTH>['getState']>>
type SyncState = Awaited<ReturnType<NonNullable<typeof window.__CC_AUTH>['getSyncState']>>

const SIGNED_OUT: AuthState = { available: true, signedIn: false }
const IDLE: SyncState = { status: 'idle' }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '') : 'Something went wrong.'
}

function syncTime(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { relative: value, absolute: value }
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const scale: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month']]
  let amount = seconds
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [limit, nextUnit] of scale) {
    if (Math.abs(amount) < limit) break
    amount = Math.round(amount / limit)
    unit = nextUnit
  }
  return {
    relative: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit),
    absolute: date.toLocaleString(),
  }
}

/** Desktop-only account controls. Tokens and PKCE material never enter here. */
export function AccountPanel() {
  const bridge = window.__CC_AUTH
  const [auth, setAuth] = useState<AuthState>(() => window.__CC_DESKTOP?.authState ?? SIGNED_OUT)
  const [sync, setSync] = useState<SyncState>(IDLE)
  const [busy, setBusy] = useState(false)
  const [pendingProvider, setPendingProvider] = useState<'github' | null>(null)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
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
      setError(message)
      setBusy(false)
      // Keep Cancel visible: the main process intentionally preserves a valid
      // pending attempt when an unrelated or forged callback arrives.
    })
    return () => {
      removeSession()
      removeSync()
      removeError()
      clearSignInTimer()
      if (signInPending.current) bridge.cancelSignIn().catch(() => {})
      signInPending.current = false
    }
  }, [bridge])

  if (!bridge) return null

  const startSignIn = async () => {
    const attempt = ++signInAttempt.current
    setBusy(true)
    setPendingProvider('github')
    signInPending.current = true
    setError('')
    setAnnouncement('')
    clearSignInTimer()
    try {
      await bridge.signIn('github')
      if (attempt !== signInAttempt.current) return
      signInTimer.current = setTimeout(() => {
        signInPending.current = false
        bridge.cancelSignIn().catch(() => {})
        setBusy(false)
        setPendingProvider(null)
        setError('Sign-in timed out. Try again when you are ready.')
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
    setBusy(true)
    try { setAuth(await bridge.cancelSignIn()); setError('') }
    catch (err) { setError(messageOf(err)) }
    finally { setBusy(false); setPendingProvider(null) }
  }

  const signOut = async () => {
    setBusy(true); setError('')
    try {
      setAuth(await bridge.signOut())
      setAnnouncement('Signed out. Local files and settings were not changed.')
    } catch (err) { setError(messageOf(err)) }
    finally { setBusy(false) }
  }

  const deleteAccount = async () => {
    setBusy(true); setError('')
    try {
      const next = await bridge.deleteAccount()
      setAuth(next)
      if (!next.signedIn) setAnnouncement('Account deleted. Local files and this Mac’s settings were not changed.')
    } catch (err) { setError(messageOf(err)) }
    finally { setBusy(false) }
  }

  const syncNow = async () => {
    setError('')
    setSync((current) => ({ ...current, status: 'syncing' }))
    try {
      const result = await bridge.pullSettings()
      const current = await bridge.getSyncState()
      setSync({ ...current, overwritten: result?.overwritten ?? current.overwritten })
    } catch (err) {
      setSync((current) => ({ ...current, status: 'error', message: messageOf(err) }))
    }
  }

  const timestamp = syncTime(sync.updatedAt)

  if (!auth.available) return <InlineNotice>Sign-in is not included in this build. ContextCake remains fully usable locally.</InlineNotice>

  if (!auth.signedIn) return (
    <section className="cc-account" aria-labelledby="cc-account-title" aria-busy={busy}>
      <div className="cc-account-profile">
        <div className="cc-account-identity">
          <h2 id="cc-account-title">Account</h2>
          <p className="cc-account-note">Preferences and safe source metadata can follow you across Macs.</p>
          <p className="cc-account-note"><strong>Sign-in is optional.</strong> ContextCake remains fully usable without an account.</p>
        </div>
      </div>
      {pendingProvider ? (
        <div className="cc-account-pending" role="status">
          <StatusBadge tone="info">GitHub</StatusBadge>
          <strong>Finish signing in in your browser.</strong>
          <span>This window will update automatically when GitHub returns you to ContextCake.</span>
          <Button type="button" variant="secondary" onClick={cancelSignIn}>Cancel</Button>
        </div>
      ) : (
        <Button type="button" variant="primary" disabled={busy} onClick={startSignIn}>Continue with GitHub</Button>
      )}
      <p className="cc-account-note">Settings sync never uploads document contents, local paths, commands, or credentials.</p>
      {auth.notice && <InlineNotice>{auth.notice}</InlineNotice>}
      {error && <InlineNotice tone="error">{error} <button type="button" onClick={startSignIn}>Try again</button></InlineNotice>}
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </section>
  )

  return (
    <section className="cc-account" aria-labelledby="cc-account-title" aria-busy={busy}>
      <div className="cc-account-profile">
        <span className="cc-account-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2" /><path d="M5.8 19.5a6.2 6.2 0 0 1 12.4 0" /></svg></span>
        <div className="cc-account-identity">
          <h2 id="cc-account-title">{auth.email ?? 'Signed in'}</h2>
          <p className="cc-account-note">Connected with GitHub</p>
        </div>
        <StatusBadge tone="success">Signed in</StatusBadge>
      </div>

      <div className="cc-account-sync">
        <div>
          <strong>{sync.status === 'syncing' ? 'Syncing' : sync.status === 'synced' ? (sync.overwritten ? 'Updated from another Mac' : 'Settings synced') : sync.status === 'error' ? 'Offline or unable to sync' : 'Ready to sync'}</strong>
          {timestamp && <span title={timestamp.absolute}>Last synced {timestamp.relative} · {timestamp.absolute}</span>}
          {sync.status === 'error' && <span>{sync.message || 'Local settings are unchanged.'}</span>}
        </div>
        <Button type="button" variant="secondary" disabled={sync.status === 'syncing'} onClick={syncNow}>{sync.status === 'error' ? 'Retry' : 'Sync now'}</Button>
      </div>

      <div className="cc-account-actions"><Button type="button" variant="secondary" disabled={busy} onClick={signOut}>Sign Out</Button></div>

      <section className="cc-account-danger-zone" aria-labelledby="cc-danger-title">
        <div><h3 id="cc-danger-title">Danger Zone</h3><p>Delete the cloud account and synced settings. Local files and this Mac’s settings remain.</p></div>
        <Button type="button" variant="danger" disabled={busy} onClick={deleteAccount}>Delete Account…</Button>
      </section>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </section>
  )
}
