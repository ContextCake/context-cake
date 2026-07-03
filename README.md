# ContextCake Console

A React + TypeScript implementation of the **ContextCake Console** design
(exported from Claude Design). It replaces the old "Mission Control" dashboard
with one cohesive tool for understanding and resolving a team's knowledge
cascade — Company → Team → Personal, where higher layers override per section.

## Stack

- **React 18** + **TypeScript**, bundled with **Vite**
- No CSS framework — the flat visual system (IBM Plex Sans/Mono, the
  Blue/Teal/Amber/Neutral semantic ramps, hairline borders) is reproduced with
  design tokens and per-element inline styles.
- **Theming** — every color is a CSS variable (`src/styles.css`) with a light
  "paper" set and a Railway-inspired dark "canvas" set. `C` in `src/theme.ts`
  holds the variable references, and `css()` remaps any literal hex written
  inline onto the same variables, so the whole app themes by flipping
  `data-theme` on `<html>`. Dark-first, persisted in `localStorage`, toggled
  from the header (`src/theme-mode.tsx`, `src/components/ThemeToggle.tsx`).

## Run

```bash
npm install
npm run dev        # dev server (default http://localhost:5173)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck (tsc) + production build to dist/
npm run preview    # serve the production build
```

## Deploy

Hosted on **Cloudflare Pages** (project `contextcake-console`). The build output
is the static `dist/` directory — any static host works.

```bash
npm run build
npx wrangler pages deploy dist --project-name=contextcake-console --branch=main
```

CI mirrors this: pushing to `main` publishes a Pages preview
(`.github/workflows/preview.yml`); tagging `v*` deploys production
(`.github/workflows/deploy.yml`). Both need the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repository secrets — until those are set, the workflows
still run typecheck + build and simply skip the deploy step.

## What's inside

A canvas home, four structured views, and an "Ask ContextCake" slide-over, all
driven by real state:

- **Canvas** (home) — a Railway-style dark, dotted, pan/zoom canvas. The three
  layers are precedence lanes (Personal → Team → Company, highest on top);
  concepts are node-cards auto-laid-out into their effective lane. Where a lower
  layer disagrees, an amber dashed edge drops to a "ghost" card showing the
  overridden value — the provenance/conflict story made spatial. Click a node →
  concept detail slides in; click a ghost or the resolver CTA → the Conflicts
  view. Wheel to zoom (toward cursor), drag to pan, plus zoom/fit controls.
- **Overview** — stat tiles, the cascade as a layer-cake, context-source health
  with coverage bars, a "Needs you" block, and recent activity.
- **Triage** — Review / Stored / Discarded tabs, signal cards, and a sticky
  decision panel that shows *why a signal routed* and *where it lands* in the
  cake. Keyboard shortcuts on this view: **S** store, **R** keep in review,
  **D** discard.
- **Conflicts** — disagreeing layers side by side, the higher one marked
  `EFFECTIVE`, with one-click resolution (keep / promote / personal override /
  annotate).
- **Concepts** — the *resolved* read of each concept with per-section
  provenance and inline dissent.
- **Ask ContextCake** — an assistant that answers from the resolved cascade and
  cites which layer each fact came from. It calls the Claude harness
  (`window.claude.complete`) when available and falls back to grounded canned
  answers otherwise.

## Structure

```
src/
  theme.ts              tokens (CSS-var refs) + style helpers (lc/rc/badge, css hex→var)
  theme-mode.tsx        dark/light provider — default dark, persisted, data-theme on <html>
  data.ts               sample cascade: layers, sources, signals, conflicts, concepts
  store.tsx             app state + actions (route, resolveConflict, chat send)
  App.tsx               shell + view routing + S/R/D keyboard handler
  components/           Sidebar, Header, ChatPanel, ConceptDetail, LayerChip, ThemeToggle
  views/                Canvas, Overview, Triage, Conflicts, Concepts
  styles.css            light + dark variable sets, keyframes, scrollbar, hover, canvas dots
```

## Notes

- The data in `src/data.ts` is illustrative sample content; swap it for live
  MCP / graph data when wiring to a backend.
- State is in-memory (React), so triage decisions and conflict resolutions reset
  on reload — persist them via your API when integrating for real.
- The original Claude Design handoff (chat transcript, HTML prototype, reference
  assets) is preserved under `project/` — see `project/HANDOFF.md` for provenance.
