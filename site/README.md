# ContextCake site

The public marketing + docs site. Astro + Starlight, static output, deployed to
Cloudflare Pages (build root `site/`, output `site/dist/`).

For release-state definitions across the repo, see
[`../docs/go-live.md`](../docs/go-live.md). The site and the console do not use
the same release trigger.

**Read first:** [`specs/contextcake-site/spec.md`](../specs/contextcake-site/spec.md)
(what/why, EARS acceptance criteria) and
[`specs/contextcake-site/design.md`](../specs/contextcake-site/design.md)
(brand system, IA, phases, boundaries). The design doc's §9 is the working contract
for build agents — commands, structure, code style, and the three-tier boundaries.

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # the gate — must exit 0 before any commit
npm run preview
```

## Scaffold state (what exists vs. what's a stub)

- **Real:** brand tokens (`src/styles/tokens.css` — the single source of truth for
  color/type), base layout + nav, homepage hero with static banded composite,
  copy-command component, strata logo mark, Starlight shell with the full sidebar IA.
- **Stubs with `TODO(agent)` markers:** all 16 docs pages (each names its source
  material), homepage sections 2–6, `/install` (gated on spec Open Questions),
  `/demo` (Phase 5), `/changelog`.

## Non-negotiables

- Colors and fonts only via `var(--cc-*)` tokens. The three layer colors are product
  semantics (personal amber / team teal / company indigo) — never repurpose them.
- Self-hosted assets only; no CDN, no analytics.
- Site dependencies stay in `site/package.json`; the engine remains dependency-free.
- Demo/merge output shown on the site must come from the real resolver at build time.
