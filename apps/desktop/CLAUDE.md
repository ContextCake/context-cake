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
npm run smoke:relaunch   # engine restart re-points the window at the new origin
npm run test:isolation   # engine must not block the UI thread, and must keep
                         # answering itself (3,000-doc / ~90MB corpus)
npm run icon    # regenerate build/icon.icns + icon-master-1024.png from assets/brand/contextcake-app-icon.svg
npm run pack    # unpacked .app (fast) — dist/ is gitignored
npm run dist    # DMG + zip, ad-hoc signed in dev
```

## Gotchas

- **CI runs Node 22; a green local run on Node 24 is not proof.** The two differ
  on when the test runner gives up on a pending promise, and this package is
  full of deliberately `unref()`ed timers (ack deadlines, the watchdog), so a
  test whose only pending work is one of them passes on 24 and fails on 22 with
  "Promise resolution is still pending but the event loop has already resolved".
  The fix belongs in the test — a ref'd keepalive while it awaits the deadline —
  never in the source: dropping an `unref()` to green a test puts a multi-second
  stall into every quit. Reproduce with
  `/opt/homebrew/opt/node@22/bin/node --test test/*.test.mjs` before blaming CI.
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
- **The engine's V8 heap ceiling cannot be raised, only watched.** Probed
  empirically on Electron 43 (2026-08-12): `utilityProcess.fork` accepts
  `execArgv: ['--max-old-space-size=…']` but V8 ignores it (the flag reaches
  `process.execArgv` and does nothing), `NODE_OPTIONS` is likewise ignored,
  `v8.setFlagsFromString` is too late at child runtime, and `resourceLimits`
  is a worker_threads option utilityProcess does not have. The ceiling is
  fixed at ~4.2GB (`heap_size_limit` 4192MB, bundled Node 24.18). Consequences:
  the engine's memory watermark keys off the measured limit
  (`packages/core/src/memory-pressure.mjs`), `/api/status` surfaces it as
  `memoryDetail`, and keeping index/resolve memory bounded is a hard
  requirement, not a nicety. (Same probe: `node:sqlite` IS available in the
  utilityProcess as of Electron 43 — recorded for the future, unused today.)
- **Engine stdio is piped and teed into `~/Library/Logs/ContextCake/engine.log`**
  (`src/main/engine-log.mjs`, 5MB rotation to `engine.log.1`, redirect with
  `CC_ENGINE_LOG_DIR` in tests). For a Finder-launched .app the old
  `stdio: 'inherit'` was /dev/null, so an engine death left no artifact at all
  — the log is the app's only durable diagnostic trail, which is why the smoke
  test asserts one gets written and `npm run test:isolation` asserts the
  `[index]` pass lines land in it. Terminal visibility for `npm run dev` is
  preserved by forwarding the same chunks to the app's own stdio. The log must
  never crash the app: every writer is wrapped, an unwritable dir yields a
  null log, and everything degrades to silence.
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
- **A post-boot engine EXIT is restarted on a bounded budget; a WEDGE is
  offered as a manual restart; a BOOT failure is fatal — three paths, never
  shared.** The old invariant ("an unasked-for exit stays fatal because
  re-forking could loop") is replaced: the loop it feared is impossible by
  construction. `handleEngineCrash` (main.mjs) + `engine-crash-policy.mjs`
  (pure, unit-tested): at most 2 crash-triggered restarts per 10-minute
  window (backoff 1s/10s), the budget forgiven after 5 healthy minutes; each
  crash appends `{at, code, indexingSources}` to `engine-crashes.json` in
  userData (last 5); when the two most recent in-window crashes were mid-index
  on exactly ONE shared source, that source is quarantined for the next
  generation (`sendQuarantine` over the message port → engine
  `setIndexQuarantine` parks it as an error row — session-scoped, cleared by
  remove/re-add or app restart; an ambiguous intersection restarts without
  blaming anyone). Budget exhausted → the app STAYS OPEN behind an honest
  "Engine Stopped" dialog with the watchdog's Restart Engine banner still
  live. The most likely healthy-engine death is an OOM mid-index — knowable
  and recoverable — which is exactly the case the fatal-exit policy used to
  turn into "the app crashed". `npm run smoke:crash` proves the whole arc
  (two deaths → quarantine → surviving third generation); boot failures keep
  `handleFatal` and its boot copy. The wedge path is unchanged:
  `src/main/engine-watchdog.mjs` pings `GET /api/status` every 10s, >3 misses
  raises the banner, 60s unresponsive offers `relaunchEngine()` (proven by
  `npm run smoke:relaunch`). Never route a wedge through `handleFatal`.
- **`reload()`/`sendTokens()` resolve to `{acked}`, and the flag is the point.**
  `src/main/ack-channel.mjs` resolves `{acked: false, reason}` when the
  message-port deadline expires; the old code resolved the same empty promise
  either way, so a wedged engine's silence was indistinguishable from agreement
  (`npm run smoke` now fails on an unacked reload — verified by suppressing the
  ack, where the pre-change code printed `SMOKE OK`). Never make these reject:
  the settings-pull path does not await them, and an unhandled rejection on the
  main process is the fatal handler.
- **Every path that ends the app must stop the engine first** via
  `shutdownEngine()` in `main.mjs`. `app.exit()` does not fire `before-quit`,
  so skipping it makes a normal shutdown look like a crash and reports a
  bogus fatal error. `shutdownEngine()` also bumps an epoch, and
  `startEngine()` refuses to adopt a handle forked before that bump — a quit
  landing inside `relaunchEngine`'s `await` otherwise left an engine nobody
  would ever `close()`, and `close()` is the only thing that tells the engine
  to kill the MCP servers it spawned.
- **`before-quit` fires BEFORE the window's `close`, and `close` again after.**
  On ⌘Q the order is `before-quit → close → closed → will-quit → quit`. So
  anything that must be captured *from* a window at exit belongs in
  `before-quit` (the frame is still alive there), and anything a `close`
  handler queues is landed by `before-quit`'s `flushSettingsSync()`. Saving
  window geometry only in `close` lost it on every ⌘Q, because the async write
  queue outlived nothing. `test/quit-persistence.test.mjs` drives it through
  the real binary.
- **On macOS the red X no longer reaches `quit` or `before-quit` at all.**
  It is `close → closed → window-all-closed`, and then the app keeps running:
  `window-all-closed` only quits off-darwin, because quitting there made the
  `activate` handler unreachable and the Dock icon dead. The consequence for
  anything written in a `close` handler is that **there is no `flushSettingsSync()`
  behind it** — the async settings queue is the only thing that lands it, and
  the app may sit with no windows indefinitely. `test/quit-persistence.test.mjs`
  synthesizes a quit to keep asserting the ⌘Q ordering; the surviving-close
  path is `test/window-lifecycle.test.mjs`, which also pins that rebuilding the
  window is serialized (two Dock clicks must not make two main windows) and
  that the app can still exit afterwards.
- **A settings write can fail, and the caller has to hear about it.**
  `settings.mjs` writes asynchronously through a queue; a failed write KEEPS
  `unflushed` (so reads stay honest and the next patch retries it) and reports
  `{ok: false}` on the `written` promise that `writeSettings`/
  `writeLocalSettings` hand back. `preferences:set` and `ui-state:set` await it
  and reject the `invoke`, which is how the renderer learns. `written` never
  rejects, on purpose: an ignored return must not reach the main process's
  `unhandledRejection`, which is `handleFatal`. Never restore a `finally` that
  clears `unflushed` regardless of outcome — that is what made a failed write
  silently revert to the stale file while telling the console it was saved.
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
- **The CLI runs a second engine, and it does not share the app's.** The shim
  execs `src/cli/cli.mjs`, which forks an engine entrypoint against the same
  manifest the app's utility process is already serving. That independence is
  the point (the CLI works with the app closed), but `contextcake mcp` — the
  harness connection — is long-lived and normally runs *while* the app is open,
  so the two overlap for hours. `mcp-server.mjs` has no background index: it
  re-walks every layer root and reloads every concept per `list_concepts` /
  `search`, so a vault the app indexed once gets walked again per tool call,
  with only the OS page cache shared. Each engine also spawns its own child for
  every `"source":"mcp"` layer (one manifest entry, two server processes), and
  a shared `cache` directory gives each process its own memory cache and TTL
  clock. Live git layers are safe but lossy under contention — `git-core.mjs`'s
  advisory lock makes the loser skip its pull, not wait. Nothing here corrupts
  anything; it is duplicated work and split freshness. The fix, when it is
  worth building, is to dispatch to the running app's loopback service, and the
  blocker is that the bearer deliberately exists only in memory and on the
  message port (see the comment at the spawn site in `src/cli/cli.mjs`).
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
