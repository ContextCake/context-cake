// Injected by the ContextCake desktop app's preload script
// (apps/desktop/src/preload.cjs). Absent in every browser deployment — all
// consumers must treat it as optional.
export {}

type DesktopAuthState = {
  available?: boolean
  signedIn: boolean
  email?: string
  notice?: string
}

type SettingsSyncState = {
  status: 'idle' | 'syncing' | 'synced' | 'error'
  message?: string
  updatedAt?: string | null
  overwritten?: boolean
}

declare global {
  interface Window {
    __CC_DESKTOP?: {
      /** Per-launch bearer token the local engine service requires on /api/*. */
      token: string
      /** Desktop app version. Update UX is owned by the app's native updater. */
      version: string
      /** Initial auth snapshot; subscribe through __CC_AUTH for live state. */
      authState: DesktopAuthState
    }
    __CC_AUTH?: {
      getState(): Promise<DesktopAuthState>
      signIn(provider: 'github'): Promise<{ opened: boolean }>
      cancelSignIn(): Promise<DesktopAuthState>
      signOut(): Promise<DesktopAuthState>
      deleteAccount(): Promise<DesktopAuthState>
      onSessionChanged(cb: (state: DesktopAuthState) => void): () => void
      onError(cb: (message: string) => void): () => void
      syncSettings(settings: Record<string, unknown>): Promise<{ localOnly: boolean }>
      pullSettings(): Promise<{ overwritten?: boolean; settings: Record<string, unknown> } | null>
      getSyncState(): Promise<SettingsSyncState>
      onSyncStatus(cb: (state: SettingsSyncState) => void): () => void
      onSettingsPulled(cb: (settings: Record<string, unknown>) => void): () => void
      bootstrapTheme(theme: 'light' | 'dark'): Promise<'light' | 'dark'>
    }
  }
}
