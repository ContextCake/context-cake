# Go Live

This repo has multiple public-facing surfaces. "Live" does not mean one thing
everywhere.

## Surfaces

| Surface | What it is | Live means | Current release path |
|---|---|---|---|
| `apps/site/` | Marketing site, docs, and `/demo` redirect | The static Astro build is published to the production site/domain | Site-only changes deploy from `main`; every `app-v*` release also rebuilds and deploys the site from the released commit so versioned download links match the app. |
| `apps/console/` | Shared React renderer; its hosted form is the public Web Demo | The demo build from the released commit is published to the production Cloudflare Pages project `contextcake-console` | There is no independent Console release. The `ContextCake Release` workflow deploys the Web Demo and version-aware site after publishing the signed app from the same `app-v*` tag. |
| `apps/desktop/` | Electron Mac host for the shared renderer and local engine | A signed, notarized DMG/zip and updater metadata are published in the GitHub Release for an `app-v*` tag | The `ContextCake Release` workflow verifies public-deployment credentials before publication, then verifies the tag is on `main` and matches `apps/desktop/package.json`, signs/notarizes the app, publishes it, and deploys the matching Web Demo and site. Releases ship without accounts, so no Supabase configuration is required; without the complete Apple credential set the workflow builds unsigned inspection artifacts, publishes no release, and does not deploy the public surfaces. |
| `packages/core/` | Node-based engine, MCP server, CLI, write path | There is no hosted "live" environment by default | "Live" here means a tagged/released version people can clone and run, or another distribution channel defined in `specs/contextcake-distribution/spec.md`. |
| `apps/control-surface/` and local playground/demo assets | Local demo/prototype surfaces | Served locally or embedded into the site | Not production by themselves. They are live only if folded into the site or another shipped surface. |

**GitHub Releases rule:** any GitHub Release that is not an `app-v*` ContextCake release
must be published as a prerelease or draft. The desktop updater reads the
repo-wide `releases/latest` feed (`apps/desktop/src/main/updater.mjs:16-21`); if
a non-app release becomes "latest", `latest-mac.yml` 404s and every
installed app's update check quietly fails until the next app release.

## Operational meanings

### `Merged`

The code is on `main`. This is a source-control state only.

Merge safety is enforced separately by the repository CI workflow. The intended
required check is `CI / required`, which succeeds only when the root engine
tests, `apps/console/` build, `apps/site/` build, and the desktop navigation,
auth/sync, startup, and failure-path smoke checks all pass.

### `Preview`

The code is published somewhere non-production for review.

- For the Web Demo, the repo has a GitHub Actions preview workflow on
  pushes to `main`, validating the build first and then deploying to a
  Cloudflare Pages preview alias when the Cloudflare secrets are configured.
- For `apps/site/`, production deploy is automated on `main` changes under `apps/site/`;
  the workflow validates and rebuilds `apps/site/` before publishing. Use manual
  dispatch if a redeploy is needed without a source change.

### `Live`

The production URL that users should treat as canonical is serving the new
version.

- For the Web Demo, that means the production Pages deployment in the matching
  `app-v*` release workflow ran successfully. A merged PR or preview alone does
  not satisfy this. `release.json` records the released tag and commit.
- For `apps/site/`, that means the appropriate production deployment completed:
  `Site Production Deploy` for ordinary content, or `ContextCake Release` for
  version-aware release content.
- For `apps/desktop/`, that means the `ContextCake Release` workflow published signed and
  notarized artifacts for an `app-v*` tag on `main`; a successful unsigned artifact
  build is not live.

## Current project rule

When someone asks "is this live?", answer with the surface name:

- "the Web Demo matches app release `app-vX.Y.Z` in production"
- "the renderer is merged but the Web Demo is only on preview"
- "`apps/site/` is merged, but production deploy has not completed yet"
- "`apps/desktop/` is merged, but no signed `app-v*` release exists yet"
- "the engine is released" or "the engine is only on `main`"

Do not answer "yes" without naming the surface and the release state.

## Release checklist by surface

### Renderer / Web Demo preview

1. Merge the PR to `main`.
2. Verify local `npm run typecheck` and `npm run build` in `apps/console/`.
3. Confirm the `Web Demo Preview Deploy` workflow ran, passed validation, and
   produced a Pages preview URL.
4. Do not promote the preview independently; production follows the next
   coordinated `app-v*` release.

### `apps/site/`

1. Merge the PR to `main`.
2. Verify local `npm run build` in `apps/site/`.
3. Confirm the `Site Production Deploy` workflow completed its validation and
   deploy jobs, or run it manually. Version bumps are the exception: the
   coordinated `ContextCake Release` rebuilds and deploys the site after the
   signed app is published.
4. Confirm the canonical production domain serves the intended build.

### ContextCake app + public surfaces release

1. Merge the PR to `main` and verify desktop tests plus both smoke checks.
2. Set `apps/desktop/package.json` to the release version and push the matching
   `app-v*` tag from a commit reachable from `main`.
3. Confirm the workflow's codesign, Gatekeeper, notarization, stapling, checksums,
   app publication, Web Demo deployment, site deployment, and post-deploy
   provenance verification all pass.
4. Confirm the downloaded artifact and updater feed. The automated verifier
   checks the deployment-specific Web Demo and site URLs; final acceptance also
   checks the canonical URLs after propagation.

If either public deployment fails after the app is published, rerun the failed
`public-surfaces` job. Its immutable Web Demo artifact is retained for seven
days, and rerunning redeploys both surfaces from the original tagged commit;
do not create a second release tag to repair a deployment.

Releases ship without accounts by default, so no Supabase setup is part of this
checklist. An accounts-enabled build (`CC_ACCOUNTS=1`) is a deliberate exception:
follow `apps/desktop/README.md` and complete the manual acceptance checks in
`docs/release-gates.md` before distributing one.

### engine / MCP / CLI

1. Merge the PR to `main`.
2. Run root validation (`npm test`).
3. Decide which distribution channel is being updated: source checkout, GitHub
   release, package/distribution artifact, or another installer path.
4. Publish that channel.
5. Confirm users can actually obtain and run the released version.
