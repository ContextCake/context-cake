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

type CliStatus = 'installed' | 'missing' | 'stale' | 'conflict' | 'blocked' | 'development'

type ThemePreference = 'system' | 'light' | 'dark'
type Density = 'comfortable' | 'compact'

type DesktopPreferences = {
  theme: ThemePreference
  density: Density
  updateCheck: boolean
  anonymousMetrics: boolean | null
  reducedTransparency: boolean
  highContrast: boolean
}

type DeviceUiState = {
  sidebar: { collapsed: boolean; width: number }
  lastView: import('./shell-navigation').ViewId
  knowledgeView: import('./shell-navigation').KnowledgeSubview
  reviewView: import('./shell-navigation').ReviewSubview
  settingsPane: 'general' | 'indexing' | 'integrations' | 'account' | 'privacy'
}

interface CliResult {
  status: CliStatus
  message: string
  /**
   * Absolute path of the app-bundled `contextcake` shim, for sudo-free harness
   * connection when the /usr/local/bin name is unusable. Null in development
   * builds and in the translocated/DMG `blocked` state, whose paths are
   * ephemeral and must never reach a harness configuration.
   */
  shimPath: string | null
}

declare global {
  /**
   * A stored source credential as the renderer is allowed to see it: which
   * account, on which host, added when. Deliberately no token field — the
   * secret never crosses the bridge outward.
   */
  type GithubConnection = {
    alias: string
    login: string
    gitHost: string
    apiHost: string
    tokenType: 'pat' | 'device'
    createdAt: string
  }

  interface Window {
    __CC_DESKTOP?: {
      /** Fetch the per-launch engine bearer through the desktop's trusted IPC gate. */
      getApiToken: () => Promise<string>
      /** Desktop app version. Update UX is owned by the app's native updater. */
      version: string
      /** Initial auth snapshot; subscribe through __CC_AUTH for live state. */
      authState: DesktopAuthState
      preferences?: {
        initial: DesktopPreferences
        get(): Promise<DesktopPreferences>
        set(patch: Partial<Pick<DesktopPreferences, 'theme' | 'density' | 'updateCheck' | 'anonymousMetrics'>>): Promise<DesktopPreferences>
        onChanged(cb: (preferences: DesktopPreferences) => void): () => void
      }
      uiState?: {
        initial: DeviceUiState
        set(patch: Partial<DeviceUiState>): Promise<DeviceUiState>
      }
      commands?: {
        onInvoke(cb: (command: 'command-palette' | 'search' | 'ask' | 'settings' | 'toggle-sidebar' | `destination:${1 | 2 | 3 | 4 | 5}`) => void): () => void
      }
      /** Open the native macOS directory picker. Null means the user canceled. */
      chooseFolder?: () => Promise<string | null>
      /** Explicit, user-controlled anonymous usage-metrics preference. */
      metrics?: {
        getEnabled: () => Promise<boolean | null>
        setEnabled: (enabled: boolean) => Promise<boolean>
      }
      /** Fixed native operations for ContextCake's own command-line tool. */
      cli: {
        getStatus: () => Promise<CliResult>
        install: () => Promise<CliResult>
      }
    }
    /**
     * Source credentials. Separate from __CC_AUTH on purpose: connecting
     * GitHub needs no ContextCake account and exists in builds that ship none.
     */
    __CC_INTEGRATIONS?: {
      list(): Promise<GithubConnection[]>
      addToken(token: string, host?: string): Promise<GithubConnection>
      disconnect(alias: string): Promise<{ removed: boolean }>
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
