# ContextCake Desktop

Electron shell for the ContextCake Mac app. Engine in an isolated utility
process behind a token-guarded loopback service; console build as the renderer. Read
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
npm run test:isolation   # engine must not block the UI thread (2500-doc corpus)
npm run icon    # regenerate build/icon.icns + icon-master-1024.png from assets/brand/contextcake-app-icon.svg
npm run pack    # unpacked .app (fast) — dist/ is gitignored
npm run dist    # DMG + zip, ad-hoc signed in dev
```

## Gotchas

- **Never add dependencies to the engine.** This package may hold Electron
  deps; `packages/core` stays dependency-free. The app imports the engine by
  path (dev: repo-relative; packaged: `process.resourcesPath/engine`) — see
  `src/main/paths.mjs` for the dual resolution.
- **The engine runs in a utilityProcess, never on the main process**
  (`src/main/engine-process.mjs`, supervised by `src/main/service-host.mjs`).
  Folder walks, markdown parsing, the tokenizer and spawned MCP servers must
  not share the UI thread — that was the "Resolving…" freeze.
  `npm run test:isolation` fails if that work moves back (400ms main-loop
  ceiling; measured ~30ms isolated vs ~694ms sharing the loop). The child has
  no `electron` module: pass it plain paths via argv. The bearer token travels
  up the engine message port and reaches the preload only through trusted IPC;
  it must never appear in engine or renderer argv (visible in `ps`).
- **Source credentials are separate from accounts, and separate from the API
  bearer.** `src/main/github-connections.mjs` holds GitHub tokens in
  `tokens.enc` (its own file, not `session.enc` — clearing a sign-in must not
  drop a GitHub connection). They reach the engine as an alias → `{secret, host}`
  map over the utilityProcess message port (`sendTokens`), never argv or env,
  for the same `ps`-visibility reason the bearer travels up it. Connecting
  GitHub works with accounts switched off — that independence is why
  `registerIntegrationIpc()` is registered outside `initializeAccounts()`.
  `list()` returns metadata only; there is deliberately no IPC channel that
  hands a stored secret to the renderer. Every connection records the host it
  was minted for — twice, `apiHost` and `gitHost` — which is what lets the
  engine withhold it from a layer whose `apiBase`, or a remote whose URL,
  points elsewhere.
- **Never hand git a credential without resetting its helper chain first.**
  `gitCloneOrPull` (engine, `service.mjs`) passes `-c credential.helper=`
  before its own one-shot helper. Git's chain is cumulative and normally ends
  at `osxkeychain`, so supplying a token without the reset makes *git* write it
  into the login keychain — a copy outside `tokens.enc`, surviving uninstall,
  invisible to Disconnect. The secret rides the child's env (argv is
  `ps`-readable); `GIT_TRACE*`/`GIT_CURL_VERBOSE` are stripped so a tracing var
  already in the user's shell can't dump the exchange. Proven against the real
  git binary in `packages/core/tests/git-auth.test.mjs`.
- **Every path that ends the app must stop the engine first** via
  `shutdownEngine()` in `main.mjs`. `app.exit()` does not fire `before-quit`,
  so skipping it makes a normal shutdown look like a crash and reports a
  bogus fatal error.
- **The renderer is sandboxed** (`contextIsolation`, `sandbox: true`). The only
  bridge is `src/preload.cjs`: `window.__CC_DESKTOP` exposes static launch metadata,
  while `window.__CC_AUTH` exposes the narrow auth/settings IPC surface. Keep both
  minimal; the console must keep working in plain browsers.
- **Reveal in Finder never takes a path from the renderer.**
  `contextcake:reveal-file` accepts a source NAME and a path relative to it;
  `src/main/reveal.mjs` resolves the root from the manifest on disk and runs the
  engine's own guards (`layerRootMap` + `assertInsideRoot`, imported by path, not
  copied) before `shell.showItemInFolder`. A path that escapes its source folder
  is refused, never clamped — clamping would answer a request nobody made, and
  quietly. Keep the payload shape: a channel that accepted an absolute path would
  let a compromised renderer point Finder anywhere on the machine. The manifest
  is read through the engine's `readContextManifestQuarantined`, the same
  read-path tolerance `service.mjs` uses — a strict read throws on the whole
  file, which made one hand-edited layer disable Reveal for every healthy source.
  `scripts/navigation-test.mjs` covers traversal, an absolute rel, an out-of-root
  symlink, a layer with no folder, a manifest holding a broken layer, and the
  trusted-window policy.
- **Every `/api` call needs the bearer token** — the console's `apiFetch`
  (apps/console/src/api.ts) injects it automatically. Raw `fetch('/api/…')`
  in renderer code will 401 inside the app.
- **`resources/bin/contextcake` must stay executable** (mode 755) and POSIX-sh
  compatible — it's exec'd before any Node exists.
- **Harness connection is sudo-free.** The `contextcake:cli-status` and
  `cli-install` IPC results carry `shimPath` — the packaged shim's absolute
  path — and the console builds every harness connect command from it when the
  `/usr/local/bin` name is unusable (`missing`/`stale`/`conflict`). The PATH
  symlink install is an optional nicety, never a gate. `shimPath` is null in
  development and in the `blocked` (translocated/DMG) state: those paths are
  ephemeral and must never reach a harness configuration — keep that null, and
  keep the console's status gate, if you touch either side.
- **The first-run metrics consent prompt waits for the first layer.** A fresh
  install with zero manifest layers defers the dialog until the manifest
  watcher sees a layer land (or until a later launch that has one); installs
  that already have layers prompt at boot. The decision lives in
  `src/main/metrics-consent.mjs` (no Electron imports, covered by `npm test`).
  On consent-accept the first-launch report fires immediately — don't separate
  them, or counting silently slips to the next launch. Dialogs stay behind
  `app.isPackaged`, so CI and smoke runs never see them.
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
- **Builds ship without accounts.** `npm run pack`/`npm run dist` write
  `build/supabase-config.json` as `{"accounts":"disabled"}` and need no
  credentials; the packaged app has no sign-in and `loadSupabaseConfig` treats
  that marker as authoritative over env and userData, so a stale
  `VITE_SUPABASE_*` in a shell cannot switch sign-in back on in a shipped
  artifact. Set `CC_ACCOUNTS=1` plus `SUPABASE_URL`/`SUPABASE_ANON_KEY` to build
  one with accounts — only publishable/legacy-anon keys are accepted, never
  secret/service-role — and clear `docs/release-gates.md` before distributing
  it. The auth and settings-sync code, migrations and tests all still exist and
  still run in CI; only the packaging default changed. Rationale for the
  default: `docs/release-gates.md`.
