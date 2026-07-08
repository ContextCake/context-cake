import { useEffect, useState } from 'react'
import { C, css, MONO } from '../theme'
import { ThemeToggle } from './ThemeToggle'
import {
  checkForUpdate, isUpdateCheckEnabled, setUpdateCheckEnabled, type UpdateInfo,
} from '../update'

/**
 * Sidebar-foot cluster: a non-blocking "update available" banner (when one
 * exists and the check is enabled) plus the theme toggle and an update-check
 * opt-out menu. Never gates render; the check is disable-able and PII-free.
 */
export function UpdatePill({ mode }: { mode: 'demo' | 'live' }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [enabled, setEnabled] = useState(() => isUpdateCheckEnabled(mode))
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!enabled) { setInfo(null); return }
    let cancelled = false
    void checkForUpdate(__APP_VERSION__).then((result) => {
      if (!cancelled) setInfo(result)
    })
    return () => { cancelled = true }
  }, [enabled])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    setUpdateCheckEnabled(next)
    if (!next) { setInfo(null); setDismissed(false) }
  }

  return (
    <>
      {enabled && info && !dismissed && (
        <div style={css(`display:flex; align-items:center; gap:6px; padding:7px 8px 7px 12px; border-radius:11px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-family:${MONO}; font-size:11px; color:${C.tealText};`)}>
          <a
            href={info.url}
            target="_blank"
            rel="noopener noreferrer"
            style={css(`flex:1; min-width:0; color:${C.tealText}; text-decoration:none; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`)}
          >
            Update &rarr; v{info.latest}
          </a>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update notice"
            title="Dismiss for this session"
            style={css(`display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0; border:none; background:transparent; color:${C.tealText}; cursor:pointer; font-size:12px; line-height:1; flex:0 0 auto;`)}
          >&times;</button>
        </div>
      )}
      <div className="cc-sidebar-foot-row">
        <ThemeToggle />
        <div style={css('position:relative; flex:0 0 auto;')}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Update check settings"
            aria-expanded={menuOpen}
            title="Update check settings"
            className="round-icon"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
          {menuOpen && (
            <div style={css(`position:absolute; bottom:calc(100% + 8px); left:0; z-index:20; padding:10px 12px; border-radius:10px; background:${C.raised}; border:1px solid ${C.line}; box-shadow:0 8px 24px rgba(0,0,0,0.18); white-space:nowrap;`)}>
              <label style={css(`display:flex; align-items:center; gap:7px; font-size:12px; color:${C.body}; cursor:pointer;`)}>
                <input type="checkbox" checked={enabled} onChange={toggle} />
                Check for updates
              </label>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
