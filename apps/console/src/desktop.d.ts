// Injected by the ContextCake desktop app's preload script
// (apps/desktop/src/preload.cjs). Absent in every browser deployment — all
// consumers must treat it as optional.
//
// Deadlines: every method here is an IPC round trip to the main process, and
// none of them takes an AbortSignal — the deadline, where one is needed, has to
// live on this side. `getApiToken` has one (api.ts), because apiFetch awaits it
// on the critical path of every request and a stall there froze the whole app.
// The rest are user-initiated actions behind a visible busy state on a surface
// that is already gone if the main process has stopped answering, so they are
// deliberately unbounded rather than accidentally so.
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
      windowRole?: 'main' | 'settings'
      /** Fetch the per-launch engine bearer through the desktop's trusted IPC gate. */
      getApiToken: () => Promise<string>
      /** Desktop app version. Update UX is owned by the app's native updater. */
      version: string
      /** Initial auth snapshot; subscribe through __CC_AUTH for live state. */
      authState: DesktopAuthState
      /** True only when the macOS window supplies native translucent material. */
      nativeVibrancy?: boolean
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
        onInvoke(cb: (command: 'command-palette' | 'search' | 'ask' | 'settings' | 'toggle-sidebar' | 'view:files' | `destination:${1 | 2 | 3 | 4 | 5}`) => void): () => void
      }
      windows?: {
        openSettings(pane?: DeviceUiState['settingsPane']): Promise<{ opened: boolean; existing: boolean }>
        onSettingsPane(cb: (pane: DeviceUiState['settingsPane']) => void): () => void
      }
      data?: {
        requestReload(): Promise<{ requested: boolean }>
        onReloadRequested(cb: () => void): () => void
      }
      /** Open the native macOS directory picker. Null means the user canceled. */
      chooseFolder?: () => Promise<string | null>
      /**
       * Show a file in Finder. Takes a source name and a path INSIDE that
       * source — never an absolute path. The main process resolves it against
       * the manifest and refuses anything that escapes the source's folder,
       * answering `{ ok: false, error }` rather than throwing.
       */
      revealFile?: (layer: string, rel: string) => Promise<{ ok: boolean; error?: string }>
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
      pullSettings(): Promise<{ overwritten?: boolean; settings: Record<string, unknown> } | null>
      getSyncState(): Promise<SettingsSyncState>
      onSyncStatus(cb: (state: SettingsSyncState) => void): () => void
    }
  }
}
