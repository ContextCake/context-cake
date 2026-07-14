# ContextCake Desktop

Electron shell for the ContextCake Mac app. Engine in the main process behind
a token-guarded loopback service; console build as the renderer. Read
`specs/contextcake-distribution/design.md` before changing process
architecture, packaging, or update behavior.

## Commands

```bash
cd apps/desktop
npm install
npm run dev     # build console renderer + launch
npm run smoke   # headless boot check: service up, token enforced, exits
npm run pack    # unpacked .app (fast) — dist/ is gitignored
npm run dist    # DMG + zip, ad-hoc signed in dev
```

## Gotchas

- **Never add dependencies to the engine.** This package may hold Electron
  deps; `packages/core` stays dependency-free. The app imports the engine by
  path (dev: repo-relative; packaged: `process.resourcesPath/engine`) — see
  `src/main/paths.mjs` for the dual resolution.
- **The renderer is sandboxed** (`contextIsolation`, `sandbox: true`). The only
  bridge is `src/preload.cjs` exposing `window.__CC_DESKTOP` (token + version).
  Keep that surface minimal; the console must keep working in plain browsers.
- **Every `/api` call needs the bearer token** — the console's `apiFetch`
  (apps/console/src/api.ts) injects it automatically. Raw `fetch('/api/…')`
  in renderer code will 401 inside the app.
- **`resources/bin/contextcake` must stay executable** (mode 755) and POSIX-sh
  compatible — it's exec'd before any Node exists.
- **`notarize: false` in electron-builder.yml is deliberate** until release
  secrets exist; the release workflow overrides it. Never ship an unnotarized
  artifact to users (distribution spec §7).
- User data layout is contractual (design §5): config in
  `~/Library/Application Support/ContextCake/`, caches in
  `~/Library/Caches/ContextCake/`. Updates must never write to either.
