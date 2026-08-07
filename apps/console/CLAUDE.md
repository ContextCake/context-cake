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

# Publish a non-production preview of the built dist/
npx wrangler pages deploy dist --project-name=contextcake-console --branch=preview-local
```

Production has no independent Console release. The `app-v*` ContextCake
release builds and deploys the matching public Web Demo from the same commit.

The gates are `npm run typecheck` (strict, `noUnusedLocals`/`noUnusedParameters`)
and `npm test`; CI runs both. dev/build/typecheck/test all regenerate
`src/generated/demo-cascade.json` + `src/generated/demo-files.json` (gitignored)
via their pre-hooks.

## Architecture

- **Entry** — `src/main.tsx` mounts `<ThemeModeProvider><StoreProvider><App/>`.
  The persisted theme is applied *before* first paint to avoid a light flash.
- **State** — `src/store.tsx` holds all app state and actions (`route`,
  `resolveConflict`, `send`, view/selection setters) in **three** contexts, split
  by how often each changes: `data` (engine answers + every action, and every
  action has a stable identity), `nav` (view and selection), `input` (the search
  box and the chat composer — changes per keystroke). `useStoreData()` /
  `useStoreNav()` / `useStoreInput()` are the narrow hooks; `useStore()` merges
  all three and re-renders on any of them — it has no production callers left,
  only test mocks, and new code should not add one. Callbacks read the freshest
  values through refs so they don't re-subscribe. State is in-memory only —
  reloads reset it. See the subscribe-narrowly gotcha below before adding a
  consumer.
- **Views** — `src/views/` (Canvas, Overview, Sources, Triage, Conflicts,
  Concepts, Files). `App.tsx` is the shell: topbar + subbar + routed view, plus
  the Triage S/R/D keyboard handler. The canvas view stays full-height inside
  the chrome. Files browses and edits the real files behind each layer through
  the engine's `/api/files` + `/api/file`, with a rendered/raw toggle for
  Markdown. It renders in demo mode too, read-only, over the generated
  `demo-files.json` snapshot (see **Data**): same tree, same documents, same
  cross-links, no Save — `canEdit = live && file.editable` gates the save
  button, the ⌘S binding and the textarea, and the raw-preview fetch is skipped
  because a snapshot carries text, not bytes. Sources manages the layers themselves —
  rename + re-level + repoint a folder-backed source (PATCH `/api/sources`),
  remove with confirm (DELETE), Sync-now for github kinds (POST
  `/api/sources/sync`) — read-only in demo mode; `live: true` layers get a
  capture warning on rename/remove.
- **Files ⇄ Concepts** — the two ends of one thing, and walkable both ways. An
  open document names the concept it resolves to (`conceptForFile`: the file's
  `rel` minus its document extension, matched against a loaded concept id —
  verified 3,000/3,000 against a real `files` layer); each contributor in
  `ConceptDetail` gets an "Open file" link, but only where `/api/files` lists a
  file for that (source, concept id) pair, so an MCP or REST-read contributor
  gets no affordance rather than one that opens on an error.
- **Setup wizard** — `src/components/SetupWizard.tsx` has two shapes from one
  component: the first-run guided narrative (personal → optional team →
  optional company MCP → review) and a one-step add-a-source mode (four-kind
  picker). Names are derived (folder basename / repo slug / MCP command
  target) but always editable; levels are steppers, not constants. GitHub
  sources fork on a public/private radio: public → `github-rest` (no clone,
  never sends `auth`/`apiBase`), private → the `github` clone kind. The mode
  is frozen at mount (`isAdding`) because the shell's `addingSource` prop
  flips live when the first add lands — don't "simplify" that back to the
  prop or the step machine changes length under a mounted step index.
- **Theming** — every color is a CSS variable in `src/styles.css` (light
  soft-control-plane default, dark primary surface under
  `:root[data-theme="dark"]`). `C` in `src/theme.ts` holds the variable references; `css()` parses inline
  `"prop:val; …"` strings into style objects **and** remaps literal hex
  colors to their variables via `HEX_VARS`.
- **Data** — `src/api.ts` is the single seam: demo mode imports a bundle
  generated at build time by shelling out to the real `packages/core/src/resolver.mjs`
  (`scripts/build-demo-data.mjs`), live mode fetches the same-origin playground
  API (`/api/status`, `/api/graph`, `/api/resolve-all`). `src/layer-files.ts` is
  the same seam for files: the demo half of `demo-files.json` is one
  `listFilesApi` listing plus a `readFileApi` answer per path, produced by
  calling the engine's own file APIs — never hand-authored, and read-only
  because only the two GET answers are captured. Adapters map wire types (`types.ts`)
  onto the view model in `src/data.ts`, deriving provenance from contributor
  levels. `src/data.ts` keeps only lane semantics and the demo-only
  triage/activity fixtures. Live errors are typed (`LiveDataError`) and
  rendered honestly — never a silent fallback to demo.
- **Chat** — `src/components/ChatPanel.tsx` + `store.send()` call
  `window.claude.complete` when present and fall back to canned answers.

Key files: `src/store.tsx` (state), `src/theme.ts` (`css()` + tokens),
`src/styles.css` (shell/theme variables), `src/views/Canvas.tsx` (pan/zoom layout),
`src/components/BackgroundActivity.tsx` (the header activity control + refresh-failure banner).

## Gotchas

- **New inline hex colors must be registered.** Inline styles are written as hex
  literals and only theme correctly if the hex is in `HEX_VARS` in
  `src/theme.ts`. An unregistered hex renders fine in light mode and silently
  fails to adapt in dark mode. Prefer the `C.*` variable refs for new code;
  if you must write a hex, add it to `HEX_VARS`.
- **Subscribing to the wrong store context fails silently.** Every view root is
  `React.memo`'d with no props, so the only thing that re-renders it is a context
  it actually subscribes to. A component that reads query-derived data without
  calling `useStoreInput()` does not throw, does not warn, and does not
  re-render — it just quietly stops updating. That shipped: `Triage` read the
  query through a store callback closed over a ref, subscribed to `data` + `nav`
  only, and the Queue's search box stopped filtering entirely. The
  render-count test could not see it, because "did not re-render" was what it
  was asserting. Two rules follow: **derive from values you subscribed to, never
  from a ref inside a stable callback** (which is why `filterSignals` is an
  exported pure function taking `query`, not a `store.filtered(tab)` method —
  the argument is what forces the caller to have subscribed); and any view in
  `SEARCHABLE_VIEWS` (`shell-navigation.ts`) must be in the case table in
  `render-hygiene.test.tsx`, which types a query that matches nothing and
  asserts the list actually empties. That suite deliberately holds both halves:
  the sidebar must NOT repaint on a keystroke, and the active view MUST.
- **Prefer `C.*` / `css()` over raw styles** so both themes and the
  reduced-motion / focus-visible rules keep working.
- **`css()` is a simple `;`/`:` splitter** — no nested rules, no `url(...)` with
  semicolons. Keep declarations flat.
- **Strict unused checks** — an unused import/local/param fails `build`. The
  build won't ship until typecheck is clean.
- **Dark-first** — default theme is dark, persisted in `localStorage` under
  `cc-theme`. Don't assume light.
- **Never block the shell on data.** `store.load.shell` is true only until the
  graph responds (milliseconds); concepts resolve after the UI is up. The
  full-page "Resolving the cascade…" gate was the first-run hang — don't add
  another one. A failed *background* refresh must not clear a working page.
- **The poll is cheap by construction.** `store.tsx` polls `/api/status`
  (O(sources), sub-millisecond, ~370 bytes) at 900ms while work is in flight and
  5s when idle, and refetches `/api/graph` + `/api/resolve-all` only when the
  content moved. The engine's `generation` also ticks for a progress counter, so
  the gate is `generation` changed **and** (the per-source content signature
  changed **or** nothing is in flight). Measured on a 3,000-note vault: 24 status
  calls, 2 resolve-alls, where the old loop issued 24 × 150MB. Polling pauses on
  `visibilitychange` and resumes on return.
- **A background failure is never silent.** The loop retries at capped backoff
  (5s) forever, keeps `load.indexingSources`, and sets `load.refreshError` —
  rendered as the header's attention-toned activity control and a dismissible
  banner with `store.retryNow()`. The old code gave up after three failures and
  said nothing, which is indistinguishable from a working page.
- **Per-source progress comes from two places and must agree.** `adaptSources`
  maps the graph; `mergeSourceStatus` folds a status pass into rows the views
  already hold, so a Sources row tracks the toolbar instead of holding the phase
  the source started in. An engine `status: "indexing"` must never render as
  `synced` — "synced · 0 concepts" over a still-reading vault is the exact lie
  this pass exists to remove. `indexing.refreshing` is the opposite case:
  serving good data while re-reading, so it gets a note, never a spinner.
- **The file listing revalidates on `filesRevalidation()`, never on
  `sources.length`.** Three views read `/api/files` (Sources, Files,
  ConceptDetail) and all three must key the refetch the same way. A rename and a
  repoint both leave the source count untouched, so a count-keyed effect went on
  answering for the old layer name and the old root until something remounted —
  a renamed 3,000-file source rendering "None on this machine".
- **`warnings` is the true count; `warningMessages` is capped at 10.** Render
  the count from `warnings`.
- **`src/markdown.ts` parses to typed data and has no dependencies.** It never
  emits HTML; `components/Markdown.tsx` renders document strings as React text
  nodes, so source content cannot become markup. Link/image URLs still go
  through a scheme allowlist. Preserve that no-HTML boundary when extending it
  — see `markdown.test.ts` and `components/Markdown.test.tsx`.
- `project/` holds the original Claude Design handoff (prototype HTML, chat,
  assets). It's provenance, not part of the build — don't import from it.
