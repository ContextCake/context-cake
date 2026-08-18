# ContextCake Site — Design

**Date:** 2026-07-02
**Status:** Approved shape (from planning session) — scaffold committed, build handed off to agents
**Spec:** `specs/contextcake-site/spec.md`
**Workflow:** Requirements-first

---

## 1. The one insight the site must land

> What agents read is a **composite**, assembled **section-by-section** across stacked
> layers — higher layer wins per section, everything else inherited, disagreements
> surfaced with dates. Not whole-document replacement.

Every page serves this. The 2026-06-24 viz brainstorm review established the failure modes
to avoid: never show a collapse-to-single-node (reads as winner-takes-all), never bury
provenance behind a click, never model layers as a strict linear stack in interactive
demos (membership is a DAG).

## 2. Brand system — "provenance stripes"

Precision instrument with one warm joke. The cake metaphor is expressed through
**stratified color only** — no cake illustrations, no cute mascot. The layer colors carry
product semantics and must mean the same thing on every surface (hero, docs code samples,
diagrams, OG images).

### Tokens (`apps/site/src/styles/tokens.css` — single source of truth)

> **Amended 2026-07-07:** this table now records the *shipped* `tokens.css` values —
> the palette drifted warm during the two /impeccable critique rounds and is ratified
> as canon (UI-revamp decision D4). Console and playground adopt the same layer-color
> semantics. The pre-launch slate/indigo values are superseded.

| Token | Value | Role |
|---|---|---|
| `--cc-canvas` | `#10110f` | page background (dark-first, warm near-black) |
| `--cc-surface` | `rgba(30,31,28,0.78)` | cards, code blocks (translucent) |
| `--cc-surface-solid` | `#1e1f1c` | opaque surface |
| `--cc-surface-raised` | `#23241f` | raised panels |
| `--cc-surface-soft` | `rgba(243,239,230,0.055)` | faint fill |
| `--cc-border` / `--cc-border-strong` | `rgba(235,226,207,0.11)` / `0.2` | hairlines |
| `--cc-text` | `#f3efe6` | primary text (warm bone) |
| `--cc-text-body` | `#d2ccc0` | body text |
| `--cc-text-muted` | `#a9a296` | secondary (large sizes / labels only) |
| `--cc-text-faint` | `#80796f` | faint / disabled |
| `--cc-layer-personal` | `#d9ab53` | Personal stratum (amber, level 3, top) |
| `--cc-layer-team` | `#8dc3a8` | Team stratum (sage-teal, level 2) |
| `--cc-layer-company` | `#8bbad1` | Company stratum (blue, level 0, base) |
| `--cc-conflict` | `#e07a56` | conflict/dissent accent — sparing |
| `--cc-cta` / `--cc-cta-hover` | `#e8e0d0` / `#f3efe6` | primary CTA (bone, `--cc-on-cta` `#11130f`) |
| `--cc-radius-sm…xl` | `10 / 16 / 22 / 30px` | shape scale |
| `--cc-transition` | `200ms cubic-bezier(0.16,1,0.3,1)` | motion |

Light mode is required for docs (Starlight default toggle); marketing pages may stay
dark-only. Amber-on-dark and all text pairs must pass 4.5:1 — verify, don't assume.

### Logo

Three stacked strata (personal/team/company colors, top to bottom), slightly offset —
a minimal sediment/cake-slice mark. Renders as inline SVG. Favicon = the mark alone.

### Typography

- **Headings / labels / body:** Bricolage Grotesque — a single humanist-grotesque
  family carrying the type system with weight contrast (400–700).
- **Code, data, provenance labels:** JetBrains Mono (400–700) — monospace *only*
  where it is meaningful (resolved output, CLI, `layer · date`), never as a
  "technical" costume.
- Self-hosted via `@fontsource/*` packages — **no Google Fonts CDN in production**.
- Large type (hero ≥ 48px), 1.5–1.75 body line-height, 65–75 ch measure in docs prose.

> **Amended 2026-07-03 (design critique).** The type system moved off
> JetBrains-Mono-headings + IBM Plex Sans — the saturated "developer tool = mono"
> reflex lane — to Bricolage Grotesque. Mono is retained strictly for code/data.
> The provenance stripes and layer colors are unchanged: they remain the brand's
> distinctive element, and monospace now *contrasts* prose (human) against
> resolved data (machine) instead of flattening everything into code.

### Voice

Plain and technically grounded. Write for people who work in technology but may not write
software. Name what ContextCake does before introducing terms such as layers, resolution,
OKF, or MCP, and explain those terms through their practical effect. The complete working
guide is `specs/contextcake-site/voice.md`.

### Motion

200–300 ms micro-interactions, color-shift hovers (no layout-shifting scale), scroll-snap
acceptable on marketing sections. Every animation has a `prefers-reduced-motion` static
equivalent.

## 3. Site architecture

```
/            Homepage (custom Astro page, dark marketing)
/docs/*      Starlight docs shell
/demo        Full-page interactive cascade demo
/install     Install & setup (custom page; content gated on distribution decision)
/changelog   Generated from GitHub releases at build time
/404         In-brand
```

## 4. Homepage — section order

1. **Hero** — plain value proposition, Mac download, live-demo and install-option links,
   plus a static resolved-concept visual generated from real resolver output.
2. **Problem** — one direct statement about company, team, and personal sources differing.
3. **How it works** — three section-level merge rules with concrete examples.
4. **App and AI tools** — what the Mac app does, what MCP connects, and the six read-only tools.
5. **Packs** — short teaser and one route to the dedicated Packs page.
6. **Details** — compact capability grid covering sources, conflicts, source kinds, review,
   the MCP surface, and the dependency-free core.
7. **Closing** — one Mac download action and one route to the other install options.

## 5. Docs information architecture

Sidebar order = reading order. Sources named per page; port and correct, don't invent.

| Page | Source material |
|---|---|
| **Getting Started** | |
| Installation | README Quick start + distribution decision |
| Your first cascade (5 min) | README layer-cake example, `apps/playground/demo-layers/` |
| Connect an agent (MCP) | README MCP tools + `mcp-server.mjs` flags |
| **Concepts** | |
| The layer cake | README + core design.md §1–3 |
| OKF bundles | README `layers.json` shape + OKF link |
| Merge semantics | README override table + core design.md |
| Conflicts & provenance | README `read_file` description; "surfaced, not hidden" |
| The trust boundary | CLAUDE.md gotcha — honest, prominent |
| **Guides** | |
| Playground tour | `apps/playground/README.md` (near-verbatim port) |
| Foreign MCP sources | README + `examples/mock-mcp-source/server.mjs` |
| The capture write path | README write path + `ingest.mjs`/`write.mjs` |
| Promoting concepts | `promote.mjs` |
| **Reference** | |
| `layers.json` manifest | README + `sources/index.mjs` |
| CLI | flags of `resolver.mjs`, `ingest.mjs`, `write.mjs`, `promote.mjs`, `mcp-server.mjs` |
| MCP tools | README table + actual response shapes from `mcp-server.mjs` |
| Override syntax | README override table |

**Correctness rule:** reference pages are written against current source, not against
`docs/architecture/README.md` (partially superseded). Anything mentioning `--hash`, `--shadow`,
`override: exception`, Group layer, or recency tiebreak is stale — those subsystems were
removed in the core re-arch.

## 6. Tech stack

- **Astro + Starlight**, static output (`apps/site/` in this repo). Docs shell, search, dark
  mode come free; marketing pages are custom Astro pages with scoped styles.
- **No Tailwind.** Styling = `tokens.css` custom properties + Astro scoped CSS. Keeps the
  dependency list short, consistent with project ethos.
- **Icons:** Lucide, inlined as SVG (no icon-font, no emoji-as-icon).
- **Hero/demo:** the homepage renders real resolver output in Astro; `/demo` embeds the
  canonical released Web Demo. Do not add a second renderer or visualization dependency.
- **Demo data seam:** `apps/site/scripts/build-demo-data.mjs` enumerates concepts in
  `apps/playground/demo-layers/` (via the manifest) and calls the resolver per concept →
  `apps/site/src/data/demo-cascade.json`, run as a `prebuild` step. `resolver.mjs --concept`
  already emits JSON; only the enumeration wrapper is new.
- **Changelog:** build-time fetch of GitHub releases (graceful empty state while none).
- **Engine stays dependency-free** — all site deps live in `apps/site/package.json` only.

## 7. Deployment

Cloudflare Pages, build root `apps/site/`, `npm run build` → `apps/site/dist`.
Site-only changes deploy from `main`. An `app-v*` release deploys the site and matching Web
Demo from the release commit. Production is **contextcake.com**. No secrets are included in
the generated site.

## 8. Delivery model

The site, documentation, demo embed, and distribution routes are shipped. Ongoing changes
land through focused pull requests, the site build gate, responsive review, and the
deployment paths in §7.

## 9. Agent handoff — completeness

### Commands

```bash
cd apps/site
npm install          # once
npm run dev          # http://localhost:4321
npm run build        # static build → dist/ (the CI gate; must exit 0)
npm run preview      # serve the built output
```

Engine tests are unaffected by site work; root `npm test` must still pass if any engine
file is touched (only `apps/site/scripts/build-demo-data.mjs` should read engine code, and
only read).

### Testing

- Gate: `npm run build` exits 0 (includes Starlight's internal link validation).
- Add `astro check` if/when TS components appear.
- Visual verification: dev server + browser at 375/768/1024/1440 before calling a page done.

### Project structure

```
apps/site/
├── astro.config.mjs        # Starlight config: title, sidebar, customCss
├── package.json            # site-only deps
├── scripts/
│   └── build-demo-data.mjs # resolver → demo-cascade.json
├── public/                 # favicon, OG images, robots.txt
└── src/
    ├── components/         # Hero.astro, StrataMark.astro, CopyCommand.astro, …
    ├── data/               # demo-cascade.json (generated; gitignored)
    ├── pages/              # index.astro, install.astro, demo.astro, changelog.astro
    ├── styles/tokens.css   # THE design tokens — single source of truth
    └── content/docs/docs/  # Starlight content → /docs/* routes
```

### Code style

- Astro components with scoped `<style>`; colors/fonts ONLY via `var(--cc-*)` tokens —
  no hard-coded hex outside `tokens.css`.
- Content in Markdown/MDX; component logic in vanilla TS/JS; match existing file naming
  (kebab-case files, PascalCase components).
- Docs prose voice = README voice. Sentence-case headings. Code samples must be runnable
  as written.

### Git workflow

- Branch from `main` (`c/<name>` convention), conventional commits
  (`feat(site):`, `docs(site):`), PR to `main`, squash merge.
- Plans/checklists never committed (`docs/plans/` is gitignored territory);
  spec + design.md are the committed artifacts.

### Boundaries

- ✅ **Always:** run `npm run build` in `apps/site/` before any commit; keep all site
  dependencies inside `apps/site/package.json`; use tokens for every color; provide
  reduced-motion fallbacks; self-host every asset.
- ⚠️ **Ask first:** adding dependencies beyond the scaffold set (Astro, Starlight,
  @fontsource, Lucide); changing brand tokens or the layer-color semantics; modifying any
  engine file; publishing anything to npm; changing repo visibility settings.
- 🚫 **Never:** commit secrets or API keys; commit `layers.json` or generated data
  (`apps/site/src/data/*.json`, `apps/site/dist/`); add third-party CDN/analytics/tracking; write
  install instructions that contradict the unresolved distribution decision as if final;
  force-push or push to `main`.

## 10. Self-verification (for build agents)

After completing any phase: **compare your output against `spec.md` and list any
acceptance criteria not addressed.** Do this before declaring the phase done.

## 11. Build notes — page-by-page (added 2026-07-02 for the agent build)

Everything below is verified against the engine as of this commit. Do not re-derive;
do not invent copy where approved copy is given.

### 11.1 Copy source of truth

The public-site voice and copy rules live in `specs/contextcake-site/voice.md`. The current
homepage and install page are the approved product explanation. Treat older headline and
tagline candidates in git history as superseded.

- Problem beats (§4.2), one short paragraph each:
  1. *Scattered* — your team's knowledge lives in repo docs, wikis, and heads; no two
     sources agree on what's current.
  2. *Agents read stale* — an AI agent reading one source gets one layer's truth,
     dated and unattributed.
  3. *Overwriting loses the dissent* — merging docs by replacement destroys the
     minority position you'll need at the next incident.
- How-it-works step names (§4.3): **Stack** (company indigo) / **Resolve** (team teal)
  / **Serve** (personal amber). One sentence each, sourced from README's "layer cake"
  section.

### 11.2 Capability grid (§4.6)

| Feature | One-liner source |
|---|---|
| Sources and conflicting versions | Resolver section output (`sourceLayer`, optional `sourceUpdated`, `conflicts[]`) |
| Folders, GitHub, and MCP sources | Manifest source adapters |
| Review before sharing | Capture and promotion write path |
| Six read-only MCP tools | `fixtures/mcp-tools-baseline.json` |
| Plain Node.js core | Node.js 22+ core with built-ins only |

### 11.3 Resolver-backed product proof

Any resolved concept shown on the homepage or install page MUST be real output of:

```bash
node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
```

The site may truncate content strings for display but must not alter the structure or
hand-author a result. Shape (verified):

```jsonc
{
  "id": "decisions/primary-db",
  "contributors": [{ "layer": "personal", "level": 3, "updated": "2026-06-28" }, …],
  "frontmatter": { "type": "decision", "title": "Primary database", … },
  "frontmatterProvenance": { "type": "personal", "title": "personal", … },
  "sections": [
    { "key": "choice", "heading": "## Choice {#choice}", "content": "…",
      "sourceLayer": "personal", "sourceUpdated": "2026-06-28",
      "conflicts": [{ "layer": "company", "updated": "2026-05-01", "content": "…" }] },
    …
  ]
}
```

(`suppressed: true` sections exist in the wild — renderers must skip them.)

### 11.4 Demo-data seam (`apps/site/scripts/build-demo-data.mjs`) — contract

1. Read `apps/playground/manifest.json` (paths are relative to the manifest file).
2. Enumerate concept IDs: for each layer path, glob `**/*.md`; the concept ID is the
   relative path minus `.md`. Union across layers. Current demo yields exactly:
   `decisions/primary-db` (3 layers), `interfaces/auth-tokens` (2),
   `runbooks/incident-response` (company only), `runbooks/deploy` (team only).
3. Resolve each ID (shell out to `resolver.mjs`, or import `resolveConcept` — read-only
   import of engine code is allowed; modifying engine files is not).
4. Emit `apps/site/src/data/demo-cascade.json`: `{ "concepts": [ <resolved objects> ] }`.
   The directory is gitignored — this file is generated, never committed, never
   hand-edited. Wire as the site `prebuild` npm script.

### 11.5 Hero visual and `/demo` constraints

Band anatomy: a leading layer-colored **swatch** (a small rounded square) before the
section heading — not a side-stripe border; mono section heading; provenance visible;
conflict state present when the resolved fixture contains one.

The homepage uses the generated static composite. `/demo` embeds the canonical released
Web Demo at `contextcake-console.pages.dev`; the site never builds another renderer copy.

Hard constraints (from the reviewed prototype — violations were specifically flagged):
- NEVER collapse to a single unstriped node (teaches whole-doc winner-takes-all — wrong).
- Provenance visible by default, not behind a click.
- Persona/viewer switching is a selector, not a linear "peel" (layer membership is a DAG).
- `prefers-reduced-motion`: skip nonessential motion.

### 11.6 Ongoing definition of done

- `npm run build` exits 0, including install and internal-link checks.
- Resolver output remains generated, never hand-authored.
- Public copy follows `voice.md` and matches current product behavior.
- Changed pages are checked at phone and desktop widths with no horizontal overflow.
