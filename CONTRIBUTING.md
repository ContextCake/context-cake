# Contributing to ContextCake

ContextCake is split into a dependency-free core plus independently built app
surfaces. Keep those boundaries intact when you make changes.

## Repo Map

```text
packages/core/        Dependency-free resolver, MCP server, source adapters, ingest/write/promote tools
apps/console/         React + Vite console app
apps/site/            Astro marketing and docs site
apps/playground/      Dependency-free local playground server and UI
apps/control-surface/ Local generated-signal dashboard
apps/okf-browser/     Local OKF graph browser
examples/             Mock MCP source and team-demo scripts
specs/                Product and implementation specs
docs/                 Architecture notes, release docs, and contributor guidance
```

The root `.mjs` files are compatibility wrappers. Canonical core code lives in
`packages/core/src/`.

## Setup

The root engine has no install step:

```bash
npm test
node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
node mcp-server.mjs --manifest apps/playground/manifest.json
```

The console and site each manage their own dependencies:

```bash
npm --prefix apps/console ci
npm --prefix apps/console run typecheck
npm --prefix apps/console test
npm --prefix apps/console run build

npm --prefix apps/site ci
npm --prefix apps/site run build
```

## Picking Work

- Prefer issues labeled `ai-ready` when the desired behavior, files, and tests
  are clear.
- Prefer `good first issue` when you are new to the repo.
- Do not implement issues labeled `needs-spec` until the missing decision is
  resolved in the issue or a spec.
- Use area labels to keep work scoped: `area:core`, `area:console`,
  `area:site`, `area:playground`, `area:docs`, and `area:packs`.

## Compatibility Rules

- Do not add root npm dependencies. The core runs on plain Node.js built-ins.
- Keep root commands working unless the PR explicitly documents a migration path.
- Update docs and tests when moving files or changing command behavior.
- Treat manifests as a trust boundary: an MCP source can spawn commands from the
  manifest.
- Keep generated files out of Git unless a spec says otherwise.

## Validation

Run the smallest relevant checks while developing, then run the broader gates
before opening a PR. `npm test` starts a local playground server, so it needs a
local environment where binding to `127.0.0.1` is allowed.

For AI contributors: state which commands you ran, include failures honestly,
and avoid broad rewrites unrelated to the issue.
