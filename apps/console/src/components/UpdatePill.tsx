import { useEffect, useState } from 'react'
import { C, css, MONO } from '../theme'
import { checkForUpdate, isUpdateCheckEnabled, type UpdateInfo } from '../update'

/**
 * Sidebar-foot cluster: a non-blocking "update available" banner (when one
 * exists and the check is enabled). Preferences now live in Settings rather
 * than being split across small controls in the sidebar.
 */
export function UpdatePill({ mode }: { mode: 'demo' | 'live' }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const enabled = isUpdateCheckEnabled(mode)

  useEffect(() => {
    if (!enabled) { setInfo(null); return }
    let cancelled = false
    void checkForUpdate(__APP_VERSION__).then((result) => {
      if (!cancelled) setInfo(result)
    })
    return () => { cancelled = true }
  }, [enabled])

  if (!enabled || !info || dismissed) return null

  return (
        <div className="cc-update-pill" style={css(`display:flex; align-items:center; gap:6px; padding:7px 8px 7px 12px; border-radius:11px; background:${C.tealFill}; border:1px solid ${C.tealStroke}; font-family:${MONO}; font-size:11px; color:${C.tealText};`)}>
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
  )
}
