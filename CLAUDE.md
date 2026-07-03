# ContextCake Console

React + Vite + TypeScript front-end for the ContextCake knowledge cascade. A
single-page console: a pan/zoom Canvas home, four structured views (Overview,
Triage, Conflicts, Concepts), and an "Ask ContextCake" chat slide-over. No
runtime dependencies beyond React; all sample data is in `src/data.ts`.

## Commands

```bash
npm install
npm run dev         # Vite dev server, http://localhost:5173
npm run typecheck   # tsc --noEmit (strict)
npm run build       # tsc -b + vite build → dist/
npm run preview     # serve the production build

# Deploy the built dist/ to Cloudflare Pages
npx wrangler pages deploy dist --project-name=contextcake-console --branch=main
```

There is no test runner or linter configured — `npm run typecheck` (strict mode,
`noUnusedLocals`/`noUnusedParameters`) is the gate. Run it before committing.

## Architecture

- **Entry** — `src/main.tsx` mounts `<ThemeModeProvider><StoreProvider><App/>`.
  The persisted theme is applied *before* first paint to avoid a light flash.
- **State** — `src/store.tsx` holds all app state and actions (`route`,
  `resolveConflict`, `send`, view/selection setters) in one context. Callbacks
  read the freshest values through refs so they don't re-subscribe. State is
  in-memory only — reloads reset it.
- **Views** — `src/views/` (Canvas, Overview, Triage, Conflicts, Concepts).
  `App.tsx` is the shell: sidebar + header + routed view, plus the Triage
  S/R/D keyboard handler.
- **Theming** — every color is a CSS variable in `src/styles.css` (light
  "paper" default, dark "canvas" under `:root[data-theme="dark"]`). `C` in
  `src/theme.ts` holds the variable references; `css()` parses inline
  `"prop:val; …"` strings into style objects **and** remaps literal hex
  colors to their variables via `HEX_VARS`.
- **Data** — `src/data.ts`: layers, sources, signals, conflicts, concepts.
  Fictional sample content; swap for live MCP/graph data when wiring a backend.
- **Chat** — `src/components/ChatPanel.tsx` + `store.send()` call
  `window.claude.complete` when present and fall back to canned answers.

Key files: `src/store.tsx` (state), `src/theme.ts` (`css()` + tokens),
`src/styles.css` (theme variables), `src/views/Canvas.tsx` (pan/zoom layout).

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
