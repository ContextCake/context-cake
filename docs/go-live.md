# Go Live

This repo has multiple public-facing surfaces. "Live" does not mean one thing
everywhere.

## Surfaces

| Surface | What it is | Live means | Current release path |
|---|---|---|---|
| `apps/site/` | Marketing site, docs, and `/demo` redirect | The static Astro build is published to the production site/domain | The `Site Production Deploy` workflow builds `apps/site/` and deploys `apps/site/dist/` to the Cloudflare Pages project `contextcake` on `main` changes under `apps/site/`, or via manual dispatch. |
| `apps/console/` | React application for reading and resolving the cascade | The built `apps/console/dist/` is published to the production Cloudflare Pages project `contextcake-console` | Production is **not** "merge to `main`". Production deploy happens when a `console-v*` tag is pushed, or when someone runs `wrangler pages deploy dist --project-name=contextcake-console --branch=main` manually. |
| `apps/desktop/` | Electron Mac application | A signed, notarized DMG/zip and updater metadata are published in the GitHub Release for an `app-v*` tag | The `App Release` workflow verifies the tag is on `main` and matches `apps/desktop/package.json`, then signs, notarizes, verifies, and publishes the artifacts. With public Supabase configuration but without the complete Apple credential set, it produces unsigned inspection artifacts only; missing Supabase configuration fails packaging. |
| `packages/core/` | Node-based engine, MCP server, CLI, write path | There is no hosted "live" environment by default | "Live" here means a tagged/released version people can clone and run, or another distribution channel defined in `specs/contextcake-distribution/spec.md`. |
| `apps/control-surface/` and local playground/demo assets | Local demo/prototype surfaces | Served locally or embedded into the site | Not production by themselves. They are live only if folded into the site or another shipped surface. |

## Operational meanings

### `Merged`

The code is on `main`. This is a source-control state only.

Merge safety is enforced separately by the repository CI workflow. The intended
required check is `CI / required`, which succeeds only when the root engine
tests, `apps/console/` build, `apps/site/` build, and the desktop navigation,
auth/sync, startup, and failure-path smoke checks all pass.

### `Preview`

The code is published somewhere non-production for review.

- For `apps/console/`, the repo currently has a GitHub Actions preview workflow on
  pushes to `main`, validating the build first and then deploying to a
  Cloudflare Pages preview alias when the Cloudflare secrets are configured.
- For `apps/site/`, production deploy is automated on `main` changes under `apps/site/`;
  the workflow validates and rebuilds `apps/site/` before publishing. Use manual
  dispatch if a redeploy is needed without a source change.

### `Live`

The production URL that users should treat as canonical is serving the new
version.

- For `apps/console/`, that means the production Pages deployment ran successfully.
  A merged PR alone does not satisfy this. The production workflow also checks
  that the `console-v*` tag points at a commit already reachable from `main`.
- For `apps/site/`, that means the `Site Production Deploy` workflow completed, or
  an equivalent manual Cloudflare Pages deploy completed, and the production
  domain serves the intended build.
- For `apps/desktop/`, that means the `App Release` workflow published signed and
  notarized artifacts for an `app-v*` tag on `main`; a successful unsigned artifact
  build is not live.

## Current project rule

When someone asks "is this live?", answer with the surface name:

- "`apps/console/` is live in production"
- "`apps/console/` is merged but only on preview"
- "`apps/site/` is merged, but production deploy has not completed yet"
- "`apps/desktop/` is merged, but no signed `app-v*` release exists yet"
- "the engine is released" or "the engine is only on `main`"

Do not answer "yes" without naming the surface and the release state.

## Release checklist by surface

### `apps/console/`

1. Merge the PR to `main`.
2. Verify local `npm run typecheck` and `npm run build` in `apps/console/`.
3. For preview: confirm the `Console Preview Deploy` workflow ran, passed its
   validation job, and produced a Pages preview URL.
4. For production: push a `console-v*` tag that points at a commit already on
   `main`, or run the manual Cloudflare Pages deploy command from `apps/console/`.
5. Confirm the production Pages URL serves the intended build.

### `apps/site/`

1. Merge the PR to `main`.
2. Verify local `npm run build` in `apps/site/`.
3. Confirm the `Site Production Deploy` workflow completed its validation and
   deploy jobs, or run it manually.
4. Confirm the canonical production domain serves the intended build.

### `apps/desktop/`

1. Merge the PR to `main` and verify desktop tests plus both smoke checks.
2. Apply the reviewed Supabase migrations, run database advisors, keep anonymous
   sign-ins disabled, enable GitHub, and allow `contextcake://auth/callback`.
3. Add the public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` release secrets;
   confirm the key is publishable/legacy-anon, never secret/service-role.
4. Set `apps/desktop/package.json` to the release version and push the matching
   `app-v*` tag from a commit reachable from `main`.
5. Confirm the workflow's codesign, Gatekeeper, notarization, stapling, checksums,
   and publication steps pass, then test the downloaded artifact and updater feed.

### engine / MCP / CLI

1. Merge the PR to `main`.
2. Run root validation (`npm test`).
3. Decide which distribution channel is being updated: source checkout, GitHub
   release, package/distribution artifact, or another installer path.
4. Publish that channel.
5. Confirm users can actually obtain and run the released version.
