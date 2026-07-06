import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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
