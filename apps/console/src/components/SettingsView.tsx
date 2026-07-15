import { useState } from 'react'
import { useThemeMode } from '../theme-mode'
import { isUpdateCheckEnabled, setUpdateCheckEnabled } from '../update'
import type { Mode } from '../api'
import { AccountPanel } from './AccountPanel'

type SettingsPane = 'general' | 'account'

const GearIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
)

const AccountIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
)

export function SettingsView({ appMode, onClose }: { appMode: Mode; onClose: () => void }) {
  const [pane, setPane] = useState<SettingsPane>('general')
  const [updatesEnabled, setUpdatesEnabled] = useState(() => isUpdateCheckEnabled(appMode))
  const { mode: theme, toggle: toggleTheme } = useThemeMode()
  const desktop = Boolean(window.__CC_DESKTOP)

  const chooseTheme = (next: 'light' | 'dark') => {
    if (next !== theme) toggleTheme()
  }

  const toggleUpdates = () => {
    const next = !updatesEnabled
    setUpdatesEnabled(next)
    setUpdateCheckEnabled(next)
  }

  return (
    <div className="cc-settings-screen">
      <aside className="cc-settings-sidebar" aria-label="Settings navigation">
        <button type="button" className="cc-settings-back" onClick={onClose} autoFocus>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          Back to app
        </button>

        <div className="cc-settings-brand">
          <span className="cc-settings-brand-mark" aria-hidden="true">C</span>
          <span>Settings</span>
        </div>

        <nav className="cc-settings-nav">
          <button type="button" aria-current={pane === 'general' ? 'page' : undefined} onClick={() => setPane('general')}>
            <GearIcon />
            General
          </button>
          <button type="button" aria-current={pane === 'account' ? 'page' : undefined} onClick={() => setPane('account')}>
            <AccountIcon />
            Account
          </button>
        </nav>
      </aside>

      <main className="cc-settings-content">
        <div className="cc-settings-column">
          {pane === 'general' ? (
            <>
              <header className="cc-settings-header">
                <p>Settings</p>
                <h1>General</h1>
                <span>Adjust how ContextCake looks and behaves on this Mac.</span>
              </header>

              <section className="cc-settings-section" aria-labelledby="cc-settings-appearance">
                <h2 id="cc-settings-appearance">Appearance</h2>
                <div className="cc-settings-group">
                  <div className="cc-settings-row">
                    <div>
                      <strong>Theme</strong>
                      <span>Choose the appearance used throughout ContextCake.</span>
                    </div>
                    <div className="cc-settings-segmented" role="group" aria-label="Theme">
                      <button type="button" aria-pressed={theme === 'light'} onClick={() => chooseTheme('light')}>Light</button>
                      <button type="button" aria-pressed={theme === 'dark'} onClick={() => chooseTheme('dark')}>Dark</button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="cc-settings-section" aria-labelledby="cc-settings-application">
                <h2 id="cc-settings-application">Application</h2>
                <div className="cc-settings-group">
                  <div className="cc-settings-row">
                    <div>
                      <strong>Automatic updates</strong>
                      <span>{desktop ? 'Managed from the ContextCake application menu.' : 'Check GitHub for new ContextCake console releases.'}</span>
                    </div>
                    {desktop ? (
                      <span className="cc-settings-value">App menu</span>
                    ) : (
                      <label className="cc-switch">
                        <input type="checkbox" checked={updatesEnabled} onChange={toggleUpdates} />
                        <span aria-hidden="true" />
                        <span className="sr-only">Check for updates automatically</span>
                      </label>
                    )}
                  </div>
                  <div className="cc-settings-row">
                    <div>
                      <strong>Version</strong>
                      <span>The installed ContextCake console version.</span>
                    </div>
                    <span className="cc-settings-value">{__APP_VERSION__}</span>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <>
              <header className="cc-settings-header">
                <p>Settings</p>
                <h1>Account</h1>
                <span>Sign in to keep preferences and source metadata consistent across Macs.</span>
              </header>
              {window.__CC_AUTH ? (
                <AccountPanel />
              ) : (
                <div className="cc-settings-empty">
                  Account sign-in is available in the ContextCake desktop app. Local features still work without an account.
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
