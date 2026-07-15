# ContextCake Console

The React front end for inspecting a resolved ContextCake cascade. It runs in
three environments from the same codebase:

- **demo** — bundled sample data for the public site;
- **live browser** — reads the local engine through `/api/graph`,
  `/api/resolve*`, and the source-management endpoints;
- **ContextCake for Mac** — the live build inside Electron, with native folder
  selection, CLI actions, optional account sync, and a per-launch API token.

Run commands below from `apps/console/`.

## Stack

- React 19, TypeScript, and Vite
- Vitest for component and layout behavior
- Token-driven CSS in `src/styles.css` plus the existing `css()` helpers in
  `src/theme.ts`
- Dark/light themes persisted in localStorage; the desktop bridge also syncs
  the theme when an account is signed in

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

- **Canvas** lays concepts into Company, Team, and Personal lanes. Columns are
  reused when their occupied lanes do not collide, keeping sparse cascades
  compact. Pan, zoom, fit, concept detail, and dissent links remain available.
- **Overview** summarizes live sources, concepts, and conflicts. Recent activity
  is demo-only until the engine exposes an activity API.
- **Queue** demonstrates review, stored, and discarded signal routing in demo
  mode; live/Desktop mode has no signal API yet and is read-only.
- **Resolve** compares live dissenting layers. Resolution mutations currently
  apply only in demo mode; live/Desktop mode is read-only.
- **Concepts** shows the effective concept with per-section provenance.
- **Ask ContextCake** uses the resolved cascade when a compatible
  `window.claude.complete` harness bridge is present. Otherwise it returns a
  visibly labeled sample answer; Electron does not currently provide that
  completion bridge.
- **Settings** opens from the sidebar or Cmd/Ctrl-comma. General holds theme and
  update preferences; Account holds optional desktop GitHub sign-in, sync state,
  sign-out, and self-service deletion.

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
  store.tsx               application state and live reload/actions
  theme.ts                CSS-variable references and style helpers
  theme-mode.tsx          local theme plus optional desktop sync
  App.tsx                 shell, modal coordination, and keyboard ownership
  components/
    Sidebar.tsx           navigation, resize/collapse, mobile drawer
    SettingsView.tsx      full-window General and Account settings
    AccountPanel.tsx      desktop auth and settings-sync controls
    SetupWizard.tsx       first-run source configuration
    ConnectAgentDialog.tsx
    ChatPanel.tsx
  views/
    Canvas.tsx
    Overview.tsx
    Triage.tsx
    Conflicts.tsx
    Concepts.tsx
  styles.css
```

## Deploy

Cloudflare Pages project `contextcake-console` serves `dist/`. A merge to
`main` is not a production release: production deploys from `console-v*` tags
or an explicit Wrangler deploy. See [`../../docs/go-live.md`](../../docs/go-live.md)
for the complete surface-level release contract.

```bash
npm run build
npx wrangler pages deploy dist --project-name=contextcake-console --branch=main
```

The original design handoff remains under `project/`; see
`project/HANDOFF.md` for provenance.
