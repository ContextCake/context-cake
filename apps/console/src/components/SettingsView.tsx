import { useEffect, useMemo, useRef, useState } from 'react'
import { useThemeMode } from '../theme-mode'
import { isUpdateCheckEnabled, setUpdateCheckEnabled } from '../update'
import type { Mode } from '../api'
import { AccountPanel } from './AccountPanel'
import { IndexingSettings } from './IndexingSettings'
import { IntegrationsPanel } from './IntegrationsPanel'
import { AccountIcon, ConnectionsIcon, IndexingIcon, PrivacyIcon, SettingsIcon } from './icons'
import { SegmentedControl } from './ui'

export type SettingsPane = 'general' | 'indexing' | 'integrations' | 'account' | 'privacy'

const DOCUMENTATION_URL = 'https://contextcake.com/docs/reference/updates-and-privacy/'
const VALID_PANES = new Set<SettingsPane>(['general', 'indexing', 'integrations', 'account', 'privacy'])

function focusables(root: HTMLElement | null) {
  return Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])
}

export function SettingsView({ appMode, onClose, onIndexingChange, surface = 'overlay' }: {
  appMode: Mode
  onClose?: () => void
  onIndexingChange?: () => void
  surface?: 'window' | 'overlay'
}) {
  const desktop = Boolean(window.__CC_DESKTOP)
  const requestedInitial = window.__CC_DESKTOP?.uiState?.initial.settingsPane
  const [pane, setPaneState] = useState<SettingsPane>(VALID_PANES.has(requestedInitial as SettingsPane) ? requestedInitial as SettingsPane : 'general')
  const [updatesEnabled, setUpdatesEnabled] = useState(() => isUpdateCheckEnabled(appMode))
  const [metricsEnabled, setMetricsEnabled] = useState<boolean | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { preference: theme, density, setPreference: setTheme, setDensity } = useThemeMode()
  const accountsAvailable = window.__CC_DESKTOP?.authState?.available === true && Boolean(window.__CC_AUTH)
  const integrationsAvailable = Boolean(window.__CC_INTEGRATIONS)

  const panes = useMemo(() => [
    { id: 'general' as const, label: 'General', icon: SettingsIcon, show: true },
    { id: 'indexing' as const, label: 'Indexing', icon: IndexingIcon, show: appMode === 'live' },
    { id: 'integrations' as const, label: 'Connections', icon: ConnectionsIcon, show: integrationsAvailable },
    { id: 'account' as const, label: 'Account', icon: AccountIcon, show: accountsAvailable },
    { id: 'privacy' as const, label: 'Privacy', icon: PrivacyIcon, show: true },
  ].filter((item) => item.show), [accountsAvailable, appMode, integrationsAvailable])

  const setPane = (next: SettingsPane) => {
    if (!panes.some((item) => item.id === next)) return
    setPaneState(next)
    window.__CC_DESKTOP?.uiState?.set({ settingsPane: next }).catch(() => {})
  }

  useEffect(() => {
    if (panes.some((item) => item.id === pane)) return
    setPaneState('general')
    window.__CC_DESKTOP?.uiState?.set({ settingsPane: 'general' }).catch(() => {})
  }, [pane, panes])

  useEffect(() => window.__CC_DESKTOP?.windows?.onSettingsPane((next) => {
    if (VALID_PANES.has(next)) setPane(next)
  }), [panes])

  useEffect(() => {
    let active = true
    const preferences = window.__CC_DESKTOP?.preferences
    preferences?.get().then((value) => {
      if (!active) return
      setMetricsEnabled(value.anonymousMetrics)
      setUpdatesEnabled(value.updateCheck)
    }).catch(() => { if (active) setMetricsEnabled(false) })
    const unsubscribe = preferences?.onChanged((value) => {
      if (!active) return
      setMetricsEnabled(value.anonymousMetrics)
      setUpdatesEnabled(value.updateCheck)
    })
    return () => { active = false; unsubscribe?.() }
  }, [])

  useEffect(() => {
    if (surface !== 'overlay') return
    const root = rootRef.current
    focusables(root)[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose?.(); return }
      if (event.key !== 'Tab') return
      const items = focusables(root)
      if (!items.length) return
      const position = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (position - 1 + items.length) % items.length : (position + 1) % items.length
      event.preventDefault()
      items[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, surface])

  const toggleUpdates = async () => {
    const previous = updatesEnabled
    const next = !previous
    setUpdatesEnabled(next)
    if (window.__CC_DESKTOP?.preferences) {
      try { setUpdatesEnabled((await window.__CC_DESKTOP.preferences.set({ updateCheck: next })).updateCheck) }
      catch { setUpdatesEnabled(previous) }
    } else setUpdateCheckEnabled(next)
  }

  const toggleMetrics = async () => {
    if (!window.__CC_DESKTOP?.preferences || metricsEnabled === null) return
    const previous = metricsEnabled
    setMetricsEnabled(!previous)
    try { setMetricsEnabled((await window.__CC_DESKTOP.preferences.set({ anonymousMetrics: !previous })).anonymousMetrics) }
    catch { setMetricsEnabled(previous) }
  }

  const indexingChanged = () => {
    onIndexingChange?.()
    if (surface === 'window') window.__CC_DESKTOP?.data?.requestReload().catch(() => {})
  }

  return (
    <div ref={rootRef} className="cc-settings-screen" role={surface === 'overlay' ? 'dialog' : undefined} aria-modal={surface === 'overlay' || undefined} aria-label="ContextCake Settings" data-surface={surface}>
      <header className="cc-settings-toolbar">
        {surface === 'overlay' && <button type="button" className="cc-settings-back" onClick={onClose} aria-label="Close Settings">Close</button>}
        <nav className="cc-settings-nav" aria-label="Settings panes">
          {panes.map(({ id, label, icon: PaneIcon }) => (
            <button key={id} type="button" aria-current={pane === id ? 'page' : undefined} onClick={() => setPane(id)}><PaneIcon size={20} /><span>{label}</span></button>
          ))}
        </nav>
      </header>

      <main className="cc-settings-content">
        <div className="cc-settings-column">
          {pane === 'general' && <>
            <header className="cc-settings-header"><h1>General</h1><span>Adjust how ContextCake looks and behaves.</span></header>
            <section className="cc-settings-section" aria-labelledby="cc-settings-appearance">
              <h2 id="cc-settings-appearance">Appearance</h2>
              <div className="cc-settings-group">
                <div className="cc-settings-row"><div><strong>Theme</strong><span>{desktop ? 'System follows the current appearance of this Mac.' : 'System follows your browser and operating system.'}</span></div><SegmentedControl label="Theme" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></div>
                <div className="cc-settings-row"><div><strong>Density</strong><span>Comfortable gives controls more room. Compact fits more knowledge on screen.</span></div><SegmentedControl label="Density" value={density} onChange={setDensity} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></div>
              </div>
            </section>
            <section className="cc-settings-section" aria-labelledby="cc-settings-application">
              <h2 id="cc-settings-application">Application</h2>
              <div className="cc-settings-group">
                <div className="cc-settings-row"><div><strong>Automatic update checks</strong><span>{desktop ? 'Check for new desktop releases automatically.' : 'Check GitHub for new ContextCake console releases.'}</span></div><label className="cc-switch"><input type="checkbox" checked={updatesEnabled} onChange={toggleUpdates} aria-label="Check for updates automatically" /><span aria-hidden="true" /></label></div>
                <div className="cc-settings-row"><div><strong>Installed version</strong><span>The version of ContextCake currently running.</span></div><span className="cc-settings-value">{window.__CC_DESKTOP?.version || __APP_VERSION__}</span></div>
              </div>
            </section>
          </>}

          {pane === 'indexing' && <><header className="cc-settings-header"><h1>Indexing</h1><span>Global limits for how much ContextCake reads from every source.</span></header><IndexingSettings onChanged={indexingChanged} /></>}
          {pane === 'integrations' && <><header className="cc-settings-header"><h1>Connections</h1><span>Connect accounts so ContextCake can read private sources.</span></header><IntegrationsPanel /></>}
          {pane === 'account' && accountsAvailable && <><header className="cc-settings-header"><h1>Account</h1><span>Optional sync for preferences and safe source metadata across Macs.</span></header><AccountPanel /></>}

          {pane === 'privacy' && <>
            <header className="cc-settings-header"><h1>Privacy</h1><span>What stays local and what leaves this Mac.</span></header>
            <section className="cc-settings-section" aria-labelledby="cc-settings-metrics">
              <h2 id="cc-settings-metrics">Anonymous metrics</h2>
              <div className="cc-settings-group">
                {desktop ? <div className="cc-settings-row"><div><strong>Share anonymous usage metrics</strong><span>ContextCake makes one small GitHub download containing the installed app version and a one-time successful-open signal. GitHub receives ordinary request metadata such as the network address used to connect. It excludes files, paths, prompts, document content, account details, credentials, and device identifiers.</span></div><label className="cc-switch"><input type="checkbox" checked={metricsEnabled === true} disabled={metricsEnabled === null} onChange={toggleMetrics} aria-label="Share anonymous usage metrics" /><span aria-hidden="true" /></label></div> : <div className="cc-settings-row"><div><strong>Desktop metrics are not active</strong><span>The browser and demo surfaces do not send ContextCake desktop usage metrics.</span></div></div>}
              </div>
            </section>
            <section className="cc-settings-section" aria-labelledby="cc-settings-local-first">
              <h2 id="cc-settings-local-first">Local-first operation</h2>
              <div className="cc-settings-group"><div className="cc-settings-row"><div><strong>Your context stays on this Mac</strong><span>Local engine work does not upload your files, paths, prompts, commands, or document content. Signing in is optional and only syncs approved preferences and sanitized source metadata.</span></div></div></div>
              <a className="cc-settings-doc-link" href={DOCUMENTATION_URL} target="_blank" rel="noreferrer">Read Updates &amp; Privacy documentation</a>
            </section>
          </>}
        </div>
      </main>
    </div>
  )
}
