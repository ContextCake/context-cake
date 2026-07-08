# ContextCake Console

React + Vite + TypeScript front-end for the ContextCake knowledge cascade. A
single-page console: a pan/zoom Canvas home, four structured views (Overview,
Triage, Conflicts, Concepts), and an "Ask ContextCake" chat slide-over. Runtime
dependencies are React plus self-hosted @fontsource fonts. Data is real
resolver output — a build-time demo bundle or the live playground API (see
**Data** below); only triage signals and the activity feed remain demo fixtures.

This is the `apps/console/` package of the ContextCake repo — the cascade engine
lives in `packages/core/` and is deliberately dependency-free. This package is one
of the only places npm dependencies live. Run every command below from `apps/console/`.

## Commands

```bash
npm install
npm run dev         # Vite dev server, http://localhost:5173 (demo mode)
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (api adapters, update check)
npm run build       # tsc -b + vite build → dist/
npm run build:live  # build with --base=/console/ for the playground mount
npm run preview     # serve the production build

# Live mode against the playground server (from the repo root):
npm run console:live   # builds, then serves console at /console/ + playground at /

# Deploy the built dist/ to Cloudflare Pages
npx wrangler pages deploy dist --project-name=contextcake-console --branch=main
```

The gates are `npm run typecheck` (strict, `noUnusedLocals`/`noUnusedParameters`)
and `npm test`; CI runs both. dev/build/typecheck/test all regenerate
`src/generated/demo-cascade.json` (gitignored) via their pre-hooks.

## Architecture

- **Entry** — `src/main.tsx` mounts `<ThemeModeProvider><StoreProvider><App/>`.
  The persisted theme is applied *before* first paint to avoid a light flash.
- **State** — `src/store.tsx` holds all app state and actions (`route`,
  `resolveConflict`, `send`, view/selection setters) in one context. Callbacks
  read the freshest values through refs so they don't re-subscribe. State is
  in-memory only — reloads reset it.
- **Views** — `src/views/` (Canvas, Overview, Triage, Conflicts, Concepts).
  `App.tsx` is the shell: topbar + subbar + routed view, plus the Triage
  S/R/D keyboard handler. The canvas view stays full-height inside the chrome.
- **Theming** — every color is a CSS variable in `src/styles.css` (light
  soft-control-plane default, dark primary surface under
  `:root[data-theme="dark"]`). `C` in `src/theme.ts` holds the variable references; `css()` parses inline
  `"prop:val; …"` strings into style objects **and** remaps literal hex
  colors to their variables via `HEX_VARS`.
- **Data** — `src/api.ts` is the single seam: demo mode imports a bundle
  generated at build time by shelling out to the real `packages/core/src/resolver.mjs`
  (`scripts/build-demo-data.mjs`), live mode fetches the same-origin playground
  API (`/api/graph`, `/api/resolve-all`). Adapters map wire types (`types.ts`)
  onto the view model in `src/data.ts`, deriving provenance from contributor
  levels. `src/data.ts` keeps only lane semantics and the demo-only
  triage/activity fixtures. Live errors are typed (`LiveDataError`) and
  rendered honestly — never a silent fallback to demo.
- **Chat** — `src/components/ChatPanel.tsx` + `store.send()` call
  `window.claude.complete` when present and fall back to canned answers.

Key files: `src/store.tsx` (state), `src/theme.ts` (`css()` + tokens),
`src/styles.css` (shell/theme variables), `src/views/Canvas.tsx` (pan/zoom layout).

## Gotchas

- **New inline hex colors must be registered.** Inline styles are written as hex
  literals and only theme correctly if the hex is in `HEX_VARS` in
  `src/theme.ts`. An unregistered hex renders fine in light mode and silently
  fails to adapt in dark mode. Prefer the `C.*` variable refs for new code;
  if you must write a hex, add it to `HEX_VARS`.
- **Prefer `C.*` / `css()` over raw styles** so both themes and the
  reduced-motion / focus-visible rules keep working.
- **`css()` is a simple `;`/`:` splitter** — no nested rules, no `url(...)` with
  semicolons. Keep declarations flat.
- **Strict unused checks** — an unused import/local/param fails `build`. The
  build won't ship until typecheck is clean.
- **Dark-first** — default theme is dark, persisted in `localStorage` under
  `cc-theme`. Don't assume light.
- `project/` holds the original Claude Design handoff (prototype HTML, chat,
  assets). It's provenance, not part of the build — don't import from it.
