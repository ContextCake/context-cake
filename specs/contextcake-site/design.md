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

### Tokens (`site/src/styles/tokens.css` — single source of truth)

| Token | Value | Role |
|---|---|---|
| `--cc-canvas` | `#0F172A` | page background (dark-first) |
| `--cc-surface` | `#1E293B` | cards, code blocks |
| `--cc-text` | `#F8FAFC` | primary text |
| `--cc-text-muted` | `#94A3B8` | secondary text (large sizes only; body muted uses `#CBD5E1`) |
| `--cc-layer-company` | `#6366F1` | Company stratum (indigo, level 0) |
| `--cc-layer-team` | `#14B8A6` | Team stratum (teal, level 2) |
| `--cc-layer-personal` | `#F59E0B` | Personal stratum (amber, level 3) |
| `--cc-conflict` | `#F87171` | conflict/dissent accent — sparing |
| `--cc-cta` | `#22C55E` | primary CTA |

Light mode is required for docs (Starlight default toggle); marketing pages may stay
dark-only. Amber-on-dark and all text pairs must pass 4.5:1 — verify, don't assume.

### Logo

Three stacked strata (personal/team/company colors, top to bottom), slightly offset —
a minimal sediment/cake-slice mark. Renders as inline SVG. Favicon = the mark alone.

### Typography

- **Headings / labels / code:** JetBrains Mono (weights 400–700)
- **Body:** IBM Plex Sans (300–700)
- Self-hosted via `@fontsource/*` packages — **no Google Fonts CDN in production**.
- Large type (hero ≥ 48px), 1.5–1.75 body line-height, 65–75 ch measure in docs prose.

### Voice

The README's voice is the brand voice: declarative, technical, zero filler.
Tagline: **"Conflicts surfaced, not hidden."**
Hero headline candidates: "Every layer of what your team knows — one effective view." /
"Team knowledge, resolved."

### Motion

200–300 ms micro-interactions, color-shift hovers (no layout-shifting scale), scroll-snap
acceptable on marketing sections. Every animation has a `prefers-reduced-motion` static
equivalent.

## 3. Site architecture

```
/            Homepage (custom Astro page, dark marketing)
/docs/*      Starlight docs shell
/demo        Full-page interactive cascade demo (Phase 5)
/install     Install & setup (custom page; content gated on distribution decision)
/changelog   Generated from GitHub releases at build time
/404         In-brand
```

## 4. Homepage — section order

1. **Hero** — headline, subhead, `npx contextcake` copy box, CTAs (Get started → /docs,
   GitHub), cascade visual. Launch state: static banded composite (real resolver output,
   bands striped by layer color, provenance labels + dates on each band, one band showing
   a `conflicts[]` chip). Phase 5 upgrades it to the animated stack→column→composite.
2. **Problem** — three beats: knowledge scattered; agents read stale/contradictory docs;
   overwriting loses the dissent.
3. **How it works** — Stack / Resolve / Serve, one stratum color each.
4. **Live demo strip** — embedded mini resolve view → links to /demo. (Phase 5; omit until then.)
5. **Feature grid** — the seven features from spec AC.
6. **For agents** — MCP tool table + a real `read_file` JSON response showing
   `contributors`, per-section `sourceLayer`, `conflicts[]`.
7. **Quickstart** — the 5-command path from README, then footer.

## 5. Docs information architecture

Sidebar order = reading order. Sources named per page; port and correct, don't invent.

| Page | Source material |
|---|---|
| **Getting Started** | |
| Installation | README Quick start + distribution decision |
| Your first cascade (5 min) | README layer-cake example, `playground/demo-layers/` |
| Connect an agent (MCP) | README MCP tools + `mcp-server.mjs` flags |
| **Concepts** | |
| The layer cake | README + core design.md §1–3 |
| OKF bundles | README `layers.json` shape + OKF link |
| Merge semantics | README override table + core design.md |
| Conflicts & provenance | README `read_file` description; "surfaced, not hidden" |
| The trust boundary | CLAUDE.md gotcha — honest, prominent |
| **Guides** | |
| Playground tour | `playground/README.md` (near-verbatim port) |
| Foreign MCP sources | README + `examples/mock-context-source.mjs` |
| The capture write path | README write path + `ingest.mjs`/`write.mjs` |
| Promoting concepts | `promote.mjs` |
| **Reference** | |
| `layers.json` manifest | README + `sources/index.mjs` |
| CLI | flags of `resolver.mjs`, `ingest.mjs`, `write.mjs`, `promote.mjs`, `mcp-server.mjs` |
| MCP tools | README table + actual response shapes from `mcp-server.mjs` |
| Override syntax | README override table |

**Correctness rule:** reference pages are written against current source, not against
`docs/architecture.md` (partially superseded). Anything mentioning `--hash`, `--shadow`,
`override: exception`, Group layer, or recency tiebreak is stale — those subsystems were
removed in the core re-arch.

## 6. Tech stack

- **Astro + Starlight**, static output (`site/` in this repo). Docs shell, search, dark
  mode come free; marketing pages are custom Astro pages with scoped styles.
- **No Tailwind.** Styling = `tokens.css` custom properties + Astro scoped CSS. Keeps the
  dependency list short, consistent with project ethos.
- **Icons:** Lucide, inlined as SVG (no icon-font, no emoji-as-icon).
- **Hero/demo viz:** vanilla JS + SVG/canvas island. No three.js unless /demo genuinely
  needs it (decide in Phase 5; occlusion risk noted in the brainstorm applies to /demo).
- **Demo data seam:** `site/scripts/build-demo-data.mjs` enumerates concepts in
  `playground/demo-layers/` (via the manifest) and calls the resolver per concept →
  `site/src/data/demo-cascade.json`, run as a `prebuild` step. `resolver.mjs --concept`
  already emits JSON; only the enumeration wrapper is new.
- **Changelog:** build-time fetch of GitHub releases (graceful empty state while none).
- **Engine stays dependency-free** — all site deps live in `site/package.json` only.

## 7. Deployment

Cloudflare Pages, build root `site/`, `npm run build` → `site/dist`.
Preview: push to main (`/deploy-preview`). Production: GitHub release (`/go-live`) →
**contextcake.com** (registered 2026-07-02; the only TLD owned — .dev/.ai were available
but not purchased). No secrets in the build; the GitHub-releases fetch is
unauthenticated (private repo → skipped/empty until visibility resolves).

## 8. Build phases

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Decisions (visibility, distribution, domain) | domain: **contextcake.com** · distribution: **clone-and-run at launch; roadmap owned by `specs/contextcake-distribution/`** · visibility: **open — the last launch gate** |
| 2 | Brand kit: logo SVG, tokens.css, OG template | scaffold has tokens; logo TODO |
| 3 | Scaffold + homepage (static hero) | scaffold committed; homepage = agent task |
| 4 | Docs port (all §5 pages) + `/doc-reviewer` pass | agent task |
| 5 | Animated hero + /demo + demo-data seam | agent task (independent of 4) |
| 6 | Launch pass: OG images, a11y audit, responsive 375/768/1024/1440, linkcheck, `/go-live` | agent task |

## 9. Agent handoff — completeness

### Commands

```bash
cd site
npm install          # once
npm run dev          # http://localhost:4321
npm run build        # static build → dist/ (the CI gate; must exit 0)
npm run preview      # serve the built output
```

Engine tests are unaffected by site work; root `npm test` must still pass if any engine
file is touched (only `site/scripts/build-demo-data.mjs` should read engine code, and
only read).

### Testing

- Gate: `npm run build` exits 0 (includes Starlight's internal link validation).
- Add `astro check` if/when TS components appear.
- Visual verification: dev server + browser at 375/768/1024/1440 before calling a page done.

### Project structure

```
site/
├── astro.config.mjs        # Starlight config: title, sidebar, customCss
├── package.json            # site-only deps
├── scripts/
│   └── build-demo-data.mjs # Phase 5: resolver → demo-cascade.json
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

- ✅ **Always:** run `npm run build` in `site/` before any commit; keep all site
  dependencies inside `site/package.json`; use tokens for every color; provide
  reduced-motion fallbacks; self-host every asset.
- ⚠️ **Ask first:** adding dependencies beyond the scaffold set (Astro, Starlight,
  @fontsource, Lucide); changing brand tokens or the layer-color semantics; modifying any
  engine file; publishing anything to npm; changing repo visibility settings.
- 🚫 **Never:** commit secrets or API keys; commit `layers.json` or generated data
  (`site/src/data/*.json`, `site/dist/`); add third-party CDN/analytics/tracking; write
  install instructions that contradict the unresolved distribution decision as if final;
  force-push or push to `main`.

## 10. Self-verification (for build agents)

After completing any phase: **compare your output against `spec.md` and list any
acceptance criteria not addressed.** Do this before declaring the phase done.
