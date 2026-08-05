import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider, applyInitialAppearance } from './theme-mode'
import { SettingsView } from './components/SettingsView'

// Apply the persisted theme before the first paint.
applyInitialAppearance()

const settingsSurface = new URLSearchParams(window.location.search).get('surface') === 'settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeModeProvider>
      {settingsSurface ? <SettingsView appMode="live" surface="window" /> : <StoreProvider><App /></StoreProvider>}
    </ThemeModeProvider>
  </StrictMode>,
)
