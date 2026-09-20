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
| `contextcake` on npm | The dependency-free CLI, installable without the Mac app | The version staged from an `app-v*` release has been approved onto the public registry with provenance | Staged only by `.github/workflows/npm-publish.yml`, dispatched with a published tag and held at the `npm-publish` environment until a maintainer approves; a second approval (`npm stage approve`, with 2FA) is what puts it on the registry. The site's install page switches to the npm route once the registry has the release. |
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

### npm CLI (`contextcake`)

The registry copy must be the same bytes as the signed release, so nothing is
ever published from a working copy, and CI cannot publish at all. `npm-publish.yml`
downloads the `.tgz` the GitHub Release carries, checks it against that release's
`SHA256SUMS`, and **stages** that file with provenance through npm's trusted
publishing. A maintainer then approves the staged version with their own 2FA.
No npm token exists, and none should be created.

Two gates, deliberately in two systems. GitHub's environment approval decides
whether the workflow runs; npm's approval decides whether users can install the
result. Compromising the GitHub side alone reaches neither `npm install` nor a
machine running `npx contextcake`.

Per release, after the `app-v*` release is public:

1. Dispatch the workflow with the published tag:
   `gh workflow run npm-publish.yml --repo ContextCake/context-cake -f tag=app-vX.Y.Z`
2. Approve the `npm-publish` environment gate. The approval is the point where a
   human confirms the tag, so it is never granted in advance.
3. Approve the staged version from any machine signed in to npm. The run summary
   prints the tarball's integrity; `npm stage view` must agree with it before
   approving, because that is the last point where the bytes can still be
   compared to the release:

   ```sh
   npm stage list contextcake
   npm stage view <stage-id>
   npm stage approve <stage-id>
   ```

   This step needs proof of presence, so it cannot be automated, delegated to a
   token, or performed by the workflow. That is the property being bought.
4. Confirm `npm view contextcake version` matches the release, and that
   `npm view contextcake dist.integrity` matches the release's `SHA256SUMS`
   entry for the tarball.
5. Confirm the install page shows the npm route. `site-deploy.yml` redeploys on
   this workflow's completion; the page reads `npm-release.json`, which only
   offers the route once the registry actually has the version. A staged but
   unapproved version is correctly invisible there.

Re-running for a version the registry already has succeeds only when the
published integrity matches the release tarball, and the workflow refuses to
stage a version that is already staged, so a repeated dispatch is safe.

One-time setup, already done and recorded here so it can be audited or redone:

- The `contextcake` npm account is a project role account on the project's `npm@`
  address, never a personal account, with 2FA required for authorization and
  writes. Publishing access requires 2FA and disallows bypass-2FA tokens.
- The name was reserved by hand-publishing a `0.0.0` placeholder from
  [`packages/npm/reserve/`](../packages/npm/reserve/README.md), because a trusted
  publisher can only be attached to a package that already exists. That
  placeholder is deprecated.
- npmjs.com carries a trusted publisher for this repository, the
  `npm-publish.yml` workflow, and the `npm-publish` environment, whose allowed
  actions are **`npm stage publish` only**. Granting it `npm publish` would
  collapse the two gates back into one.
- The `npm-publish` environment requires a maintainer's review **and** restricts
  deployments to `main`. Both halves matter: npm's trusted-publisher record
  names a repository, a workflow file, and an environment, but no ref, so
  without the branch restriction a modified `npm-publish.yml` run from any
  branch would still be handed the staging credential. The `release`
  environment is restricted the same way, to `main` and the `app-v*` tags.

### engine / MCP / CLI

1. Merge the PR to `main`.
2. Run root validation (`npm test`).
3. Decide which distribution channel is being updated: source checkout, GitHub
   release, package/distribution artifact, or another installer path.
4. Publish that channel.
5. Confirm users can actually obtain and run the released version.
