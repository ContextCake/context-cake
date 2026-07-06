# Go Live

This repo has multiple public-facing surfaces. "Live" does not mean one thing
everywhere.

## Surfaces

| Surface | What it is | Live means | Current release path |
|---|---|---|---|
| `site/` | Marketing site, docs, and `/demo` redirect | The static Astro build is published to the production site/domain | The `Site Production Deploy` workflow builds `site/` and deploys `site/dist/` to the Cloudflare Pages project `contextcake` on `main` changes under `site/`, or via manual dispatch. |
| `console/` | React application for reading and resolving the cascade | The built `console/dist/` is published to the production Cloudflare Pages project `contextcake-console` | Production is **not** "merge to `main`". Production deploy happens when a `console-v*` tag is pushed, or when someone runs `wrangler pages deploy dist --project-name=contextcake-console --branch=main` manually. |
| repo root engine | Node-based engine, MCP server, CLI, write path | There is no hosted "live" environment by default | "Live" here means a tagged/released version people can clone and run, or another distribution channel defined in `specs/contextcake-distribution/spec.md`. |
| `control-surface/` and local playground/demo assets | Local demo/prototype surfaces | Served locally or embedded into the site | Not production by themselves. They are live only if folded into the site or another shipped surface. |

## Operational meanings

### `Merged`

The code is on `main`. This is a source-control state only.

### `Preview`

The code is published somewhere non-production for review.

- For `console/`, the repo currently has a GitHub Actions preview workflow on
  pushes to `main`, deploying to a Cloudflare Pages preview alias when the
  Cloudflare secrets are configured.
- For `site/`, production deploy is automated on `main` changes under `site/`;
  use manual dispatch if a redeploy is needed without a source change.

### `Live`

The production URL that users should treat as canonical is serving the new
version.

- For `console/`, that means the production Pages deployment ran successfully.
  A merged PR alone does not satisfy this.
- For `site/`, that means the `Site Production Deploy` workflow completed, or
  an equivalent manual Cloudflare Pages deploy completed, and the production
  domain serves the intended build.

## Current project rule

When someone asks "is this live?", answer with the surface name:

- "`console/` is live in production"
- "`console/` is merged but only on preview"
- "`site/` is merged, but production deploy has not completed yet"
- "the engine is released" or "the engine is only on `main`"

Do not answer "yes" without naming the surface and the release state.

## Release checklist by surface

### `console/`

1. Merge the PR to `main`.
2. Verify local `npm run typecheck` and `npm run build` in `console/`.
3. For preview: confirm the `Console Preview Deploy` workflow ran and a Pages
   preview URL exists.
4. For production: push a `console-v*` tag or run the manual Cloudflare Pages
   deploy command from `console/`.
5. Confirm the production Pages URL serves the intended build.

### `site/`

1. Merge the PR to `main`.
2. Verify local `npm run build` in `site/`.
3. Confirm the `Site Production Deploy` workflow completed, or run it manually.
4. Confirm the canonical production domain serves the intended build.

### engine / MCP / CLI

1. Merge the PR to `main`.
2. Run root validation (`npm test`).
3. Decide which distribution channel is being updated: source checkout, GitHub
   release, package/distribution artifact, or another installer path.
4. Publish that channel.
5. Confirm users can actually obtain and run the released version.
