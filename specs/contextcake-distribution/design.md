# ContextCake Distribution — Design

**Date:** 2026-07-14
**Status:** Approved (decisions locked with John, 2026-07-14) — implementation may begin
**Workflow:** Design phase of the approved `specs/contextcake-distribution/spec.md` (Requirements-First); this document resolves the choices §10 of that spec deferred to design
**Depends on:** `specs/contextcake-distribution/spec.md`, `specs/contextcake-core/design.md`

---

## 1. Decisions at a glance

| Open question (spec §9–10) | Decision |
|---|---|
| GUI framework | **Electron** (supersedes the spec's "Tauri is the leading candidate" note — see §2) |
| Authoritative version source | **GitHub Releases** on `ContextCake/context-cake` (`app-v*` tags) + `latest-mac.yml` update feed |
| Self-update swap mechanism | **electron-updater** (Squirrel.Mac): staged download, code-signature validated, "Relaunch to update" |
| Install locations | App: `/Applications` (drag-install DMG). Config: `~/Library/Application Support/ContextCake/`. Caches: `~/Library/Caches/ContextCake/`. CLI: symlink in `/usr/local/bin` (user-initiated) |
| Release automation | **electron-builder** in GitHub Actions on `app-v*` tag: build → sign → notarize → staple → publish release assets |
| Artifact set per release | `ContextCake-<ver>-arm64.dmg`, `ContextCake-<ver>-arm64-mac.zip` (updater feed), `latest-mac.yml`, `SHA256SUMS` |
| Architecture | arm64-only first (spec §2 primary target); universal2 revisited on demand |

## 2. Why Electron

The spec's §9 tentatively named Tauri. Two facts decided against it:

1. **The engine is dependency-free Node.** In Electron it runs in the main
   process as-is. Tauri would require shipping Node as a sidecar binary
   (Node SEA, ~80MB) — erasing most of Tauri's size advantage while adding a
   second artifact to sign, notarize, version, and update, plus an IPC layer
   between the Rust shell and the sidecar.
2. **The console is the ratified product GUI** (React + Vite). It renders
   identically in either shell; Electron's Chromium removes a WebKit test
   matrix.

electron-updater also satisfies the spec's self-update criteria (§5) directly:
verified-before-apply (macOS code-signature check), staged download, no
elevated privileges, relaunch-to-update. Accepted trade-off: ~150MB installed
size. Decision made with John 2026-07-14.

## 3. Process architecture

```
ContextCake.app
├── main process
│   ├── engine service  — packages/core/src/service.mjs on 127.0.0.1:<random>,
│   │                     per-launch bearer token (see §4)
│   ├── auth broker     — OAuth deep-link handler (contextcake://), sessions in
│   │                     safeStorage (see specs/contextcake-auth/spec.md)
│   ├── updater         — electron-updater against GitHub Releases
│   └── CLI installer   — "Install command-line tool…" menu action
├── preload (contextBridge) — exposes ONLY: service origin + token, app version,
│                             updater actions, auth state events
└── renderer — apps/console production build served at /console/
               (live mode auto-selects by pathname, apps/console/src/api.ts)
```

Hard settings: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
for the renderer; navigation locked to the service origin.

## 4. The engine service seam

The read API + sources CRUD currently living in `apps/playground/server.mjs`
(graph / resolve / resolve-all / sources add-remove-patch / sources sync /
static console mount, plus the loopback + Host/Origin guards) moves to
**`packages/core/src/service.mjs`** (dependency-free). The playground wraps the
same module and keeps its editor-only endpoints (`/api/file`, `/api/section`)
and workbench UI. The desktop app gets exactly one addition: **bearer-token
auth on every `/api/*` route** (random per-launch token, injected into the
renderer via preload) — loopback + Origin checks alone don't isolate other
local users on shared Macs.

## 5. User data layout (spec §5 "config preservation")

| Path | Contents | Touched by updates? |
|---|---|---|
| `~/Library/Application Support/ContextCake/manifest.json` | layers/profiles (manifest v2) | never |
| `~/Library/Application Support/ContextCake/settings.json` | app preferences | never |
| `~/Library/Caches/ContextCake/sources/` | source cache (regenerable) | never (safe to purge) |
| Keychain (via `safeStorage`) | auth session, integration tokens | never |

First run with no manifest → the console SetupWizard (extended per plan) creates
a starter personal layer and writes a valid manifest — no hand-editing (spec §5).

## 6. CLI channel

`contextcake` is a shim script symlinked into `/usr/local/bin` by an explicit
menu action (VS Code pattern). It `exec`s the app's bundled binary with
`ELECTRON_RUN_AS_NODE=1` pointing at a bundled `cli.mjs`, dispatching to the
existing entrypoints: `mcp` (stdio `packages/core/src/mcp-server.mjs`),
`resolve`, `ingest`, `write`, `promote`. It reads the same config dir (§5) and
works with the app closed. Harness connect one-liner:

```bash
claude mcp add contextcake -- contextcake mcp
```

The `.mcpb` bundle (spec §8: leads while notarization is pending) is generated
from the same engine + manifest contract; it is a packaging task, not new code.

## 7. Update pipeline (one release → every channel)

1. Maintainer tags `app-vX.Y.Z` (tag commit must be an ancestor of `main`,
   mirroring `console-deploy.yml`).
2. `app-release.yml` (macOS runner): build console renderer → electron-builder
   package → codesign (Developer ID, hardened runtime) → `notarytool submit
   --wait` → staple → generate `SHA256SUMS` → create the GitHub Release with
   all §1 artifacts. GitHub Releases is thereby the **single authoritative
   version source** for the app, the CLI's update hint, the site's download
   button, the Homebrew cask, and the changelog page.
3. In-app: electron-updater checks on launch + every 6 hours over HTTPS to
   `github.com`/`objects.githubusercontent.com` only; a Settings toggle
   disables all checks; the check carries version/platform/arch and no PII
   (disclosed in `docs/reference/updates-and-privacy` on the site, per spec §5).
4. Package-managed installs are never self-mutated (spec §5): the cask relies
   on `brew upgrade` (`auto_updates true` so brew defers to the app updater);
   the CLI prints the correct upgrade hint for its detected channel.

## 8. Signing & secrets

- **Developer ID Application** certificate → `CSC_LINK` / `CSC_KEY_PASSWORD`
  GitHub Actions secrets.
- **App Store Connect API key** (notarytool) → `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` secrets.
- Keys exist only in the secrets store; used only by `app-release.yml`;
  rotation = revoke in the Apple portal, reissue, replace secrets (documented
  in the workflow header comment). Never in the repository (spec §7 🚫).
- Entitlements: hardened runtime with the minimal set Electron requires
  (`allow-jit`, `allow-unsigned-executable-memory`); no camera/mic/location.
- Hard gate: **no artifact ships to users before it passes
  `spctl -a -vv -t install` and `xcrun stapler validate`** (spec §7 ✅).
  Dev builds are ad-hoc signed and never distributed.

## 9. Acceptance traceability (spec §5)

| Spec §5 group | Satisfied by |
|---|---|
| Obtain & install, zero-terminal | DMG drag-install + SetupWizard (§5, §6) |
| Developer channels | CLI shim + `.mcpb` fast-follow + Homebrew cask (§6, §7.4); npm stays gated per spec §8 amendment |
| First-run setup | SetupWizard writes manifest v2 (§5) |
| Update awareness | electron-updater (app), GH-releases hint (CLI/console demo) — one version source (§7) |
| Self-update | electron-updater relaunch-to-update, signature-verified (§7) |
| Integrity & Gatekeeper | §8 |
| Release pipeline | `app-release.yml`, one tag → all artifacts + changelog (§7) |
| Config preservation | §5 layout; update path never writes there |

## 10. For the implementing agent

- New package: `apps/desktop/` with its own `package.json` (electron,
  electron-builder, electron-updater). Like `apps/console` and `apps/site`, it
  must never add dependencies to the engine; it imports `packages/core/src/*`
  by relative path.
- Commands: `npm run dev` (app against local console dev server),
  `npm run dist` (packaged, ad-hoc signed). Root `npm test` must stay green;
  service extraction (§4) must keep `playground-test.sh` passing.
- **Self-verification:** compare the implementation against
  `specs/contextcake-distribution/spec.md` §5 and list any acceptance criteria
  not addressed.
