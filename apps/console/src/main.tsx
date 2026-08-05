import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'
import { App } from './App'
import { StoreProvider } from './store'
import { ThemeModeProvider, applyInitialAppearance } from './theme-mode'

// Apply the persisted theme before the first paint.
applyInitialAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeModeProvider>
      <StoreProvider>
        <App />
      </StoreProvider>
    </ThemeModeProvider>
  </StrictMode>,
)
