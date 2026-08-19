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
  `resolveConflict`, `send`, view/selection setters) in **four** contexts, split
  by how often each changes: `data` (engine answers + every action, and every
  action has a stable identity), `nav` (view and selection), `input` (the toolbar
  search box — changes per keystroke), `chat` (the Ask composer, its transcript
  and its busy flag — changes per keystroke). `useStoreData()` / `useStoreNav()`
  / `useStoreInput()` / `useStoreChat()` are the narrow hooks; `useStore()`
  merges all four and re-renders on any of them — it has no production callers
  left, only test mocks, and new code should not add one. The two typing
  surfaces are deliberately separate contexts: `query` is read by the Header
  that owns the field and by all five searchable views, the composer only by
  `ChatPanel`, and while they shared one context a question typed into the Ask
  slide-over repainted the view under it per character. Callbacks read the
  freshest values through refs so they don't re-subscribe. State is in-memory
  only — reloads reset it. See the subscribe-narrowly gotcha below before
  adding a consumer.
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
- **Theming** — two axes, and their names differ between code and UI on
  purpose: code `theme` (`theme-mode.tsx`, `data-theme` / `data-theme-preference`
  on `<html>`, `cc-theme` in localStorage) is the UI's **"Appearance"** —
  system / light / dark; code `palette` (`data-palette`, `cc-palette`, the
  desktop `palette` preference) is the UI's **"Theme"** — which family
  (`contextcake` default, then `solarized`, `catppuccin`, `gruvbox`,
  `tokyo-night`, `rose-pine`, `one`, `github`; `src/themes/registry.ts` is the
  list, `THIRD_PARTY_THEMES.md` the notices). Every color is a CSS variable.
  ContextCake's own values live in `src/styles.css`: `:root` (light) and
  `:root[data-theme="dark"]`, and beyond the primitives (page/surface/raised,
  the ink ramp, lines, the layer trio and its blue/teal/amber ramps) the two
  blocks declare **semantic role tokens** — `--cc-solid-bg/fg` (the inverted
  chip: settings brand mark, resolver primary, and the light `--cc-cta-*`
  alias), `--cc-cta-bg/fg` (the one primary action), `--cc-ask-bg/fg/ring`
  (Ask button), `--cc-code-bg/fg` (terminal-style code block),
  `--cc-neutral-fill-hover` — and components consume those. **A theme family
  is a file `src/themes/<id>.css` with two blocks that declare the 13
  `PRIMITIVES` (+ `color-scheme`) per mode — `tokens.test.ts` enforces "every
  primitive, and only canonical token names" — and `src/themes/_derived.css`
  computes every other canonical color from them with `color-mix()`, so a
  family cannot drift from the console's structure; a family may override a
  derived token where its palette defines that role itself.** Each block
  carries two selectors:
  `:root[data-palette="x"][data-theme="y"]` for the app and
  `.cc-theme-swatch[data-palette="x"][data-theme="y"]` for the picker's
  self-previewing tiles (ContextCake's blocks list the swatch selector too),
  so a preview is the real palette painted on a `<span>`, never a hand-picked
  sample. ContextCake's dark block is scoped to its own palette
  (`:root:where([data-palette="contextcake"], :not([data-palette]))[data-theme="dark"]`,
  still (0,2,0)) so a family never competes with it; the derived block sits
  at (0,2,0), above `:root`, below every family block, and a family may
  override a derived token (Rosé Pine and GitHub bring their own border
  tones). Non-default families are opaque, and
  `_derived.css` turns the sidebar blur off for them. **A
  `:root[data-theme="dark"] .cc-*` component override fails
  `src/themes/tokens.test.ts` — extend a semantic token in both blocks (or add
  one, named by role, not by color) instead.** The same suite refuses any
  literal color (`#hex`, `rgb()`/`hsl()`/…, named colors) in a component
  rule; a translucent tint is written as
  `color-mix(in srgb, var(--cc-…) N%, transparent)`. `src/themes/contrast.ts`
  (pure WCAG math + `var()`/`color-mix()` resolver) backs
  `src/themes/contrast.test.ts`, which holds ink/body/caption and every
  ramp/solid/code/cta/ask pair to a floor **in every family and both modes,
  with no per-family exception list** — a family that cannot pass changes its
  mapping (within its official palette) or is not shipped. The constants a
  family extends — `PALETTES`, `PRIMITIVES`, `TOKEN_BLOCK_SELECTOR_RE`,
  `INHERITS_FROM_LIGHT`, `LITERAL_ALLOWLIST` — live in `src/themes/gates.ts`,
  not in a test file. `C` in `src/theme.ts` holds the variable references;
  `css()` parses inline `"prop:val; …"` strings into style objects **and**
  remaps literal hex colors to their variables via `HEX_VARS`.
- **Data** — `src/api.ts` is the single seam: demo mode imports a bundle
  generated at build time by shelling out to the real `packages/core/src/resolver.mjs`
  (`scripts/build-demo-data.mjs`), live mode fetches the same-origin playground
  API (`/api/status`, `/api/graph`, `/api/discrepancies`, per-concept
  `/api/resolve`). **Bootstrap is graph-first**: concept rows come from the
  graph summary (`adaptGraphConcept`, compact, `detailLoaded: false`), open
  conflicts give those rows their dissent surface (`attachConflictStubs` from
  the discrepancies payload — canvas ghosts and conflict badges work without
  the corpus), and a concept's full document loads on selection
  (`store.loadConceptDetail`, ~50-detail LRU that regresses evictions to their
  compact rows). `/api/resolve-all` is only called against an engine too old
  to serve `/api/discrepancies` — never on the modern path, where it was a
  ~150MB payload per bootstrap on a 3,000-note vault and the renderer-side
  crash/timeout on large vaults. `src/layer-files.ts` is
  the same seam for files: the demo half of `demo-files.json` is one
  `listFilesApi` listing plus a `readFileApi` answer per path, produced by
  calling the engine's own file APIs — never hand-authored, and read-only
  because only the two GET answers are captured. Adapters map wire types (`types.ts`)
  onto the view model in `src/data.ts`, deriving provenance from contributor
  levels. `src/data.ts` keeps only lane semantics and the demo-only
  triage/activity fixtures. Live errors are typed (`LiveDataError`) and
  rendered honestly — never a silent fallback to demo.
- **Chat** — `src/components/ChatPanel.tsx` + `store.send()` call
  `window.claude.complete` when present and fall back to canned answers. The
  panel is the only component that calls `useStoreChat()` (the other caller is
  `useStore()` itself), and should stay that way: the hook re-renders its caller
  for every character typed into the composer.

Key files: `src/store.tsx` (state), `src/theme.ts` (`css()` + tokens),
`src/styles.css` (shell/theme variables), `src/views/Canvas.tsx` (pan/zoom layout),
`src/components/BackgroundActivity.tsx` (the header activity control + refresh-failure banner).

## Gotchas

- **New inline hex colors must be registered.** Inline styles are written as hex
  literals and only theme correctly if the hex is in `HEX_VARS` in
  `src/theme.ts`. An unregistered hex renders fine in light mode and silently
  fails to adapt in dark mode. Prefer the `C.*` variable refs for new code;
  if you must write a hex, add it to `HEX_VARS`. `src/theme.test.ts` walks
  every string literal under `src/` and fails on an unregistered six-digit
  hex, on any 3-, 4- or 8-digit hex (`css()` cannot remap those), and on a
  `HEX_VARS` value that names no `--cc-*` token.
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
  the sidebar must NOT repaint on a search keystroke, and the active view MUST.
  It holds the same pair for the composer, table-driven over the same
  `SEARCHABLE_VIEWS` gate, with the Ask panel open over each view: the view must
  NOT repaint, and the composer must still hold what was typed.
- **Count renders inside the memo boundary, not at a leaf.** Views render no
  icons, so the chat cases needed a probe of their own, and the first one —
  counting `LayerChip`, which `Concepts` renders per row — was blind by
  construction: one `memo` between the view and the chip (match-highlighting,
  virtualization) zeroes the probe, and zero is what the test asserts. `counted()`
  in `render-hygiene.test.tsx` instead re-exports the view module with a counter
  wrapping the view's own inner function (unwrapping `React.memo`), so the view's
  hooks become the counter's hooks and every context it subscribes to is
  observed. A wrapper AROUND the view counts the parent, which a context-driven
  re-render never touches — the same reason `React.Profiler` reports zero here.
- **A `data` value that changes identity per provider render defeats the whole
  split, and demo-mode tests cannot see it.** `App` subscribes to `data` and
  owns every memoized child, so `data` changing identity on every provider
  render *is* a whole-tree repaint per keystroke. That shipped: `activity` was
  `mode === 'demo' ? demoActivity : []`, and the inline `[]` — live mode only —
  gave `data` a new identity every render. Both context splits measured zero in
  `render-hygiene.test.tsx` and bought nothing in the Mac app, because
  `createDataSource()` with no query string picks demo, the one mode that took
  the stable branch. Hence `NO_ACTIVITY` in `store.tsx`, and
  `render-hygiene.live.test.tsx`, which mounts the store with a source that
  reports `mode: 'live'` while still answering from the demo bundle and pins the
  same properties there. Anything added to the `data` memo's dependency list
  must be stable across a render in **both** modes.
- **Prefer `C.*` / `css()` over raw styles** so both themes and the
  reduced-motion / focus-visible rules keep working.
- **`css()` is a simple `;`/`:` splitter** — no nested rules, no `url(...)` with
  semicolons. Keep declarations flat.
- **Strict unused checks** — an unused import/local/param fails `build`. The
  build won't ship until typecheck is clean.
- **Dark-first** — default theme is dark, persisted in `localStorage` under
  `cc-theme` (and the family under `cc-palette`). Don't assume light, and
  don't assume ContextCake's colors: a family swaps every primitive.
- **An unknown palette id is normalized, never written back.** The desktop
  validates `palette` by slug shape (so a newer app or a hand-edited
  settings.json may name a family this build lacks), and a browser's
  `cc-palette` may have been written by a newer deploy; `theme-mode.tsx`
  renders such an id as ContextCake and leaves the stored value alone —
  `cc-palette` is written only from `setPalette`, unlike `cc-theme` /
  `cc-density`, which the appearance effect keeps in sync. Don't "fix" the
  file or the key from a fallback.
- **Never block the shell on data.** `store.load.shell` is true only until the
  graph responds (milliseconds); concepts resolve after the UI is up. The
  full-page "Resolving the cascade…" gate was the first-run hang — don't add
  another one. A failed *background* refresh must not clear a working page.
- **The poll is cheap by construction.** `store.tsx` polls `/api/status`
  (O(sources), sub-millisecond, ~370 bytes) at 900ms while work is in flight and
  5s when idle, and refetches the heavy payloads (`/api/graph` +
  `/api/discrepancies` — no longer `/api/resolve-all`, see **Data**) only when
  the content moved. The engine's `generation` also ticks for a progress
  counter, so the gate is `generation` changed **and** (the per-source content
  signature changed **or** nothing is in flight). A refetch rebuilds compact
  rows and re-loads the selected concept's detail so the document on screen
  never regresses to a spinner. Polling pauses on `visibilitychange` and
  resumes on return.
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
- **Dependencies belong in `apps/console/package.json`.** Never add one to the
  repo root: the engine runs on plain Node with no root install, and a root
  dependency would quietly end that.
- **`src/generated/` is generated and gitignored.** Don't hand-edit it; the
  dev/build/typecheck/test pre-hooks rewrite it.
