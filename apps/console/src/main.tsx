import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'
// Theme families (see themes/index.css); ContextCake's own tokens are in styles.css.
import './themes/index.css'
import './workbench.css'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider, applyInitialAppearance } from './theme-mode'
const SettingsView = lazy(() => import('./components/SettingsView').then((module) => ({ default: module.SettingsView })))

// Apply the persisted theme before the first paint.
applyInitialAppearance()

const settingsSurface = new URLSearchParams(window.location.search).get('surface') === 'settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeModeProvider>
      {settingsSurface ? <Suspense fallback={<div className="cc-secondary-loading" role="status">Opening settings…</div>}><SettingsView appMode="live" surface="window" /></Suspense> : <StoreProvider><App /></StoreProvider>}
    </ThemeModeProvider>
  </StrictMode>,
)
