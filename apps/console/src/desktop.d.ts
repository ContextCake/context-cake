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
  /** What the renderer should do: the user's choice, or the OS setting. */
  reducedTransparency: boolean
  /** What the user chose. null = still following this Mac's setting. */
  reducedTransparencyPreference: boolean | null
  /** What this Mac's Accessibility setting says, regardless of the override. */
  systemReducedTransparency: boolean
  highContrast: boolean
}

type DeviceUiState = {
  sidebar: { collapsed: boolean; width: number }
  lastView: import('./shell-navigation').ViewId
  knowledgeView: import('./shell-navigation').KnowledgeSubview
  reviewView: import('./shell-navigation').ReviewSubview
  settingsPane: 'general' | 'indexing' | 'integrations' | 'account' | 'privacy'
  cascadeDisplay: import('./cascade-preferences').CascadeDisplayMode
  cascadeHiddenNodes: string[]
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

  /** Status pushed by apps/desktop/src/main/updater.mjs over `updates:status`. */
  type UpdateStatus =
    | { state: 'unsupported' | 'idle' | 'checking' | 'not-available' }
    | { state: 'downloading'; version?: string; percent?: number }
    | { state: 'downloaded'; version?: string }
    | { state: 'error'; error?: string }

  interface Window {
    __CC_DESKTOP?: {
      windowRole?: 'main' | 'settings'
      /** Fetch the per-launch engine bearer through the desktop's trusted IPC gate. */
      getApiToken: () => Promise<string>
      /** Desktop app version. */
      version: string
      /**
       * Update status backed by the native autoUpdater. Optional a second
       * time within itself: a packaged app older than this channel exposes
       * `__CC_DESKTOP` without it, and Settings must hide the control rather
       * than throw.
       */
      updates?: {
        getStatus(): Promise<UpdateStatus>
        check(): Promise<UpdateStatus>
        install(): Promise<{ installed: boolean }>
        onStatus(cb: (status: UpdateStatus) => void): () => void
      }
      /** Initial auth snapshot; subscribe through __CC_AUTH for live state. */
      authState: DesktopAuthState
      /** True only when the macOS window supplies native translucent material. */
      nativeVibrancy?: boolean
      preferences?: {
        initial: DesktopPreferences
        get(): Promise<DesktopPreferences>
        set(patch: Partial<Pick<DesktopPreferences, 'theme' | 'density' | 'updateCheck' | 'anonymousMetrics'>>
          /** null is a real value: hand the choice back to this Mac's setting. */
          & { reducedTransparency?: boolean | null }): Promise<DesktopPreferences>
        onChanged(cb: (preferences: DesktopPreferences) => void): () => void
      }
      uiState?: {
        initial: DeviceUiState
        get?(): Promise<DeviceUiState>
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
      /**
       * Liveness of the local engine, as measured by the desktop shell.
       *
       * Optional like everything else here, and optional a second time within
       * itself: a packaged app older than this channel exposes `__CC_DESKTOP`
       * without it, and the console has to keep working against that build.
       */
      engine?: {
        onStatus?(cb: (state: import('./components/EngineBanner').EngineHealth) => void): () => void
        /**
         * The engine's memory-pressure watermark ("normal" | "elevated" |
         * "critical"), piggybacked on the same liveness ping as onStatus.
         * Older packaged builds won't call this back at all.
         */
        onMemory?(cb: (state: import('./components/EngineMemoryBanner').EngineMemory) => void): () => void
        /** Restart the engine process and reload this window at its new origin. */
        relaunch?(): Promise<{ ok: boolean; reason?: string }>
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
      /**
       * Show the app's configuration folder (~/Library/Application Support/
       * ContextCake) in Finder. The path is fixed on the main-process side —
       * no arguments cross the bridge.
       */
      revealConfigDir?: () => Promise<{ ok: boolean; error?: string }>
      /**
       * Show the engine log (~/Library/Logs/ContextCake/engine.log) in
       * Finder — same fixed-path doctrine as revealConfigDir. Answers
       * `{ ok: false, error }` when no log has been written yet.
       */
      revealLogs?: () => Promise<{ ok: boolean; error?: string }>
      /**
       * The local preferences file (settings.json), for support flows. Export
       * opens a native save dialog and writes a copy — the renderer never
       * names a path. Reset confirms natively in the main process, then
       * returns every preference in settings.json to its default; the
       * resulting preference state arrives through `preferences.onChanged`
       * like any other change. Renderer-local Cascade mirrors are cleared by
       * SettingsView after this succeeds. Both resolve
       * `{ok: false, canceled: true}` when the user backs out of the dialog.
       */
      settingsFile?: {
        export(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
        reset(): Promise<{ ok: boolean; canceled?: boolean }>
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
      pullSettings(): Promise<{ overwritten?: boolean; settings: Record<string, unknown> } | null>
      getSyncState(): Promise<SettingsSyncState>
      onSyncStatus(cb: (state: SettingsSyncState) => void): () => void
    }
  }
}
