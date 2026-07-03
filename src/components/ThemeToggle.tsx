import { css, C } from '../theme'
import { useThemeMode } from '../theme-mode'

export function ThemeToggle() {
  const { mode, toggle } = useThemeMode()
  const dark = mode === 'dark'
  return (
    <button
      onClick={toggle}
      className="cc-h-navbg"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light theme' : 'Dark theme'}
      style={css(`display:grid; place-items:center; width:38px; height:38px; background:${C.surface}; border:1px solid ${C.lineStrong}; border-radius:9px; cursor:pointer; color:${C.caption};`)}
    >
      {dark ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4.2" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  )
}
