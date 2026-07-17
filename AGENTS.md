# ContextCake

## Commands

```bash
# Root engine / MCP / write-path validation
npm test

# Root demo verification
npm run demo:verify

# Console app
cd apps/console
npm ci
npm run typecheck
npm run build
npm run dev

# Site
cd apps/site
npm ci
npm run build
astro dev --background
```

## Architecture

- Root `.mjs` files are compatibility wrappers. Canonical dependency-free engine, MCP, classifier, ingest, write, and promote code lives in `packages/core/src/`.
- Team sync: a manifest layer marked `"live": true` with a `git` block is the team's shared working memory (`captures/<kind>/` + telemetry NDJSON), synced through its own git repo. Capture write tools exist only behind `mcp-server.mjs --capture`; promotion to curated layers goes through `promote.mjs --from-live` and `_review/promotions/`. Pack: `examples/team-sync-pack/`.
- `apps/console/` is the React + Vite application for reading the resolved cascade. It builds independently from the engine and deploys to its own Cloudflare Pages project.
- `apps/site/` is the Astro marketing/docs surface. It also deploys independently to Cloudflare Pages.
- `apps/playground/`, `apps/control-surface/`, and `apps/okf-browser/` are local/demo surfaces over the same engine.
- `.github/workflows/ci.yml` is the merge gate. Deploy workflows under `.github/workflows/` validate and publish the console and site surfaces separately.

## Gotchas

- Do not add an install step for the repo root. The engine intentionally runs on plain Node.js without root package dependencies.
- `apps/console/` and `apps/site/` each have their own lockfile and their own `npm ci` step. There is no shared workspace install.
- `CI / required` is intended to be the only required branch protection check. Internal jobs may change, but that outer gate should remain stable.
- `console-v*` production tags should point at commits already merged to `main`. The production workflow enforces that ancestry check.
- Root `npm test` includes `packages/core/tests/playground-test.sh`, which starts a local server. If you change that test, keep it runnable in CI and configurable by `PORT`.
- The live layer's git repo is a trust boundary: push access lets anyone inject unreviewed context into every teammate's agent. Telemetry files in that repo carry concept ids and enums only — adding any content field is a spec violation.
