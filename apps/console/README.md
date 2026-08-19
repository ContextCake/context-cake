# ContextCake Console

The React front end for inspecting and resolving a ContextCake cascade. It runs in
three environments from the same codebase:

- **demo** — bundled sample data for the public site, including a snapshot of
  the files behind each layer so the navigator works read-only;
- **live browser** — reads the local engine through `/api/status` (the cheap
  poll), `/api/graph`, `/api/resolve*`, `/api/conflict-resolutions`, and the
  source-management endpoints;
- **ContextCake for Mac** — the live build inside Electron, with native folder
  selection, CLI actions, optional account sync, and a per-launch API token.

Run commands below from `apps/console/`.

## Stack

- React 19, TypeScript, and Vite
- Vitest for component and layout behavior
- Token-driven CSS in `src/styles.css` plus the existing `css()` helpers in
  `src/theme.ts`
- Two appearance axes persisted in localStorage — Appearance (system / light /
  dark) and Theme (a palette family: ContextCake, Solarized, Catppuccin,
  Gruvbox, Tokyo Night, Rosé Pine, One, GitHub; see `src/themes/` and
  `THIRD_PARTY_THEMES.md`); the desktop bridge also syncs both when an
  account is signed in

## Commands

```bash
npm ci
npm run dev          # Vite dev server, normally http://localhost:5173
npm run typecheck    # tsc --noEmit
npm test             # Vitest
npm run build        # demo build
npm run build:live   # live/Electron build at /console/
npm run preview      # serve the production build
```

To exercise live mode with the local engine, build the Console and use the root
playground/service command documented in the repository instructions.

## Product flow

- **Canvas** defaults to the Grouped Cascade view. Folders with four or more
  concepts in the same precedence lane become one summary node; opening one
  launches a separate searchable folder browser without changing the graph's
  geometry. Right-click a concept or folder to hide it from Cascade, then use
  **Hidden** to restore it. Hidden concepts remain available in Knowledge and
  Review. Pan, zoom, fit, concept detail, and dissent links remain available.
- **Overview** summarizes live sources, concepts, and conflicts, and lists the
  cascade order — one row per source, position 1 first, with what each wins
  over. Recent activity is demo-only until the engine exposes an activity API.
- **Queue** demonstrates review, stored, and discarded signal routing in demo
  mode; live/Desktop mode has no signal API yet and is read-only.
- **Resolve** clears formatting-only conflicts automatically and presents
  meaning-changing conflicts as direct answer choices. In live/Desktop mode,
  choosing an answer preflights every contributing writable local layer,
  updates them together, and appends the original answers and decision to
  `.contextcake/profiles/<profile-id>/conflict-resolutions.ndjson` beside the
  manifest. History can
  be reopened to choose a different saved answer later. The service refuses
  the whole change if a source is remote, missing, or changed since review.
- **Concepts** shows the effective concept with per-section provenance, and each
  contributor links to the file it came from.
- **Files** is the source navigator: a keyboard tree per source, scoping to one
  source, deep links (`#/files/<source>/<path>`), a rendered/raw view of each
  document, and editing with re-resolve on save. Demo mode renders the same
  navigator read-only. Sources whose content is remote — a GitHub repository
  read over the API, an MCP graph — keep no files here and say so.
- **Sources** manages the layers themselves: rename, reposition (a position
  select in the edit drawer, or **Reorder** mode — drag a row or use its arrows;
  position 1 wins and every move saves immediately), repoint a folder-backed
  source, remove, and sync. Read-only in demo mode, where the way into the
  navigator is still offered.
- **Ask ContextCake** uses the resolved cascade when a compatible
  `window.claude.complete` harness bridge is present. Demo mode falls back to
  visibly labeled sample answers. Live mode never substitutes demo knowledge:
  without a bridge it points the user to the agent connection flow instead.
  Electron does not currently provide that completion bridge.
- **Settings** opens from the sidebar or Cmd/Ctrl-comma. General → Appearance
  holds Appearance (System / Light / Dark), Theme (the palette family — a grid
  of tiles, each previewing its own light and dark halves), density, and the
  Cascade view preference persisted on this Mac (or in
  this browser): Grouped (the default), Compact, or Cards. General also holds update preferences; Account
  holds optional desktop GitHub sign-in, sync state, sign-out, and self-service
  deletion.

The desktop sidebar remembers its expanded width, can be resized by pointer or
keyboard, and collapses to a 72px icon rail. On narrow screens it becomes a
full-width off-canvas drawer.

## First run

Live mode opens setup when no source exists:

1. Personal is the minimum required layer. In the Mac app, choose a local
   folder with the native browser or paste its path.
2. Team is optional and can use a local folder or GitHub repository.
3. Company knowledge is optional. Only connect an MCP server when your
   organization provided the command and you trust its source: that command
   runs locally with your Mac user permissions.
4. Review the layers, finish setup, then use **Connect an agent** for the MCP
   client instructions.

Machine-local paths and MCP execution details are never activated from synced
metadata; each Mac requires its own local setup.

## Structure

```text
src/
  api.ts                  demo/live adapters and authenticated desktop fetch
  layer-files.ts          the same seam for /api/files and /api/file
  store.tsx               application state and live reload/actions
  theme.ts                CSS-variable references and style helpers
  theme-mode.tsx          appearance + palette state, local persistence, optional desktop sync
  themes/
    registry.ts           the palette families (ids, labels, variant names, attribution)
    _derived.css          every non-primitive token, computed from a family's primitives
    <id>.css              one file per family: 13 primitives per mode + color-scheme
    index.css             import order (imported from main.tsx after styles.css)
    contrast.ts           WCAG contrast + var()/color-mix() token resolver
    css-blocks.ts         tiny stylesheet reader behind the theme gates
    gates.ts              shared gate constants (PALETTES, PRIMITIVES, …)
    tokens.test.ts        token-set / dark-block / family / derived / registry gates
    contrast.test.ts      readability floors per family and mode
  App.tsx                 shell, modal coordination, and keyboard ownership
  components/
    Sidebar.tsx           navigation, resize/collapse, mobile drawer
    SettingsView.tsx      full-window General and Account settings
    ThemePicker.tsx       the Theme grid: one aria-pressed tile per family, self-previewing swatches
    AccountPanel.tsx      desktop auth and settings-sync controls
    SetupWizard.tsx       first-run source configuration
    FileTree.tsx          windowed ARIA tree behind the Files navigator
    ConnectAgentDialog.tsx
    ChatPanel.tsx
  views/
    Canvas.tsx
    Overview.tsx
    Triage.tsx
    Conflicts.tsx
    Concepts.tsx
    Files.tsx
    Sources.tsx
  styles.css
```

## Preview and release

Cloudflare Pages project `contextcake-console` serves the public Web Demo from
`dist/`. Merges to `main` can publish review previews, but there is no separate
Console release train. An `app-v*` ContextCake release builds the demo and Mac
renderer from the same commit, publishes the signed app, then deploys the Web
Demo and version-aware site to production. See [`../../docs/go-live.md`](../../docs/go-live.md) for the
complete release contract.

```bash
npm run build
npx wrangler pages deploy dist --project-name=contextcake-console --branch=preview-local
```

The console's visual design started as an HTML/CSS prototype exported from
Claude Design and was rebuilt in React here. The prototype bundle and its
chat transcripts are no longer carried in the repo — see history before
the repo cleanup if you need them.
