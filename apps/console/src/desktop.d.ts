// Injected by the ContextCake desktop app's preload script
// (apps/desktop/src/preload.cjs). Absent in every browser deployment — all
// consumers must treat it as optional.
export {}

declare global {
  interface Window {
    __CC_DESKTOP?: {
      /** Per-launch bearer token the local engine service requires on /api/*. */
      token: string
      /** Desktop app version. Update UX is owned by the app's native updater. */
      version: string
    }
  }
}
