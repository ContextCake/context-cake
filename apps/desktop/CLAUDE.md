# ContextCake Desktop

Electron shell for the ContextCake Mac app. Engine in the main process behind
a token-guarded loopback service; console build as the renderer. Read
`specs/contextcake-distribution/design.md` before changing process
architecture, packaging, or update behavior.

## Commands

```bash
cd apps/desktop
npm ci
npm run dev     # build console renderer + launch
npm test        # auth storage + settings-sync tests
npm run test:navigation
npm run test:cli-status
npm run smoke   # headless boot check: service up, token enforced, exits
npm run smoke:bootfail
npm run icon    # regenerate build/icon.icns + icon-master-1024.png from assets/brand/contextcake-app-icon.svg
npm run pack    # unpacked .app (fast) — dist/ is gitignored
npm run dist    # DMG + zip, ad-hoc signed in dev
```

## Gotchas

- **Never add dependencies to the engine.** This package may hold Electron
  deps; `packages/core` stays dependency-free. The app imports the engine by
  path (dev: repo-relative; packaged: `process.resourcesPath/engine`) — see
  `src/main/paths.mjs` for the dual resolution.
- **The renderer is sandboxed** (`contextIsolation`, `sandbox: true`). The only
  bridge is `src/preload.cjs`: `window.__CC_DESKTOP` exposes static launch metadata,
  while `window.__CC_AUTH` exposes the narrow auth/settings IPC surface. Keep both
  minimal; the console must keep working in plain browsers.
- **Every `/api` call needs the bearer token** — the console's `apiFetch`
  (apps/console/src/api.ts) injects it automatically. Raw `fetch('/api/…')`
  in renderer code will 401 inside the app.
- **`resources/bin/contextcake` must stay executable** (mode 755) and POSIX-sh
  compatible — it's exec'd before any Node exists.
- **The app icon is generated, never hand-edited.** `build/icon.icns` and
  `build/icon-master-1024.png` are produced by `npm run icon` from the canonical
  brand mark at `assets/brand/contextcake-app-icon.svg` (the same file the site
  and console favicons mirror). To change the icon, change the brand SVG and
  regenerate — a divergent icns is how the app shipped the old logo once already.
- **`notarize: false` in electron-builder.yml is deliberate** until release
  secrets exist; the release workflow overrides it. Never ship an unnotarized
  artifact to users (distribution spec §7).
- User data layout is contractual (design §5): config in
  `~/Library/Application Support/ContextCake/`, caches in
  `~/Library/Caches/ContextCake/`. Installers must preserve both. The native
  updater may maintain only its documented `.updaterId` rollout marker there.
- **App name is pinned three places that must agree**: `app.setName('ContextCake')`
  in `src/main/main.mjs`, `productName` in `package.json`, and the CLI's
  `CONFIG_DIR` in `src/cli/cli.mjs`. They resolve the same `userData` dir the
  app writes and the CLI reads — a mismatch breaks `contextcake mcp`. The smoke
  test asserts `userData=ContextCake`.
- **Known gaps tracked as follow-ups** (not blocking merge): the updater reads the
  repo-wide GitHub "latest" release (see the comment in `updater.mjs`).
- `npm run pack` and `npm run dist` require public Supabase configuration through
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (or the `SUPABASE_*` aliases).
  Only publishable/legacy-anon keys are accepted; never use secret/service-role keys.
