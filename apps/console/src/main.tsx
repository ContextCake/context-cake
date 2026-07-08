import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/bricolage-grotesque/400.css'
import '@fontsource/bricolage-grotesque/500.css'
import '@fontsource/bricolage-grotesque/600.css'
import '@fontsource/bricolage-grotesque/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider, applyMode, initialMode } from './theme-mode'

// Apply the persisted theme before the first paint.
applyMode(initialMode())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeModeProvider>
      <StoreProvider>
        <App />
      </StoreProvider>
    </ThemeModeProvider>
  </StrictMode>,
)
