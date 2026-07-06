# ContextCake site

Before working here, read `specs/contextcake-site/spec.md` (EARS acceptance criteria)
and `specs/contextcake-site/design.md` — §9 is the working contract: commands,
structure, code style, and three-tier boundaries (✅ always / ⚠️ ask first / 🚫 never).

## Gotchas

- Colors/fonts ONLY via `var(--cc-*)` tokens from `src/styles/tokens.css`. The layer
  colors are product semantics (personal amber / team teal / company indigo).
- Install story is **versioned release archive first**. Do not make `git clone` the
  primary user install path; keep source checkout as an audit/contribution path.
  Never add an `npm install` step for the engine.
- Docs routes live under `src/content/docs/docs/` (the extra `docs/` gives `/docs/*`
  URLs; the marketing pages own `/`). Sidebar is explicit in `astro.config.mjs`.
- Self-hosted assets only (fonts via @fontsource). No CDN, no analytics, no npm deps
  beyond the scaffold set without asking.
- `npm run build` must exit 0 before any commit. Engine tests (root `npm test`) must
  still pass if you touch anything outside `site/`.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
