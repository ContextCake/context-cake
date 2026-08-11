# Contributing to ContextCake

ContextCake is split into a dependency-free core plus independently built app
surfaces. Keep those boundaries intact when you make changes.

## Repo Map

```text
packages/core/        Dependency-free resolver, MCP server, source adapters, ingest/write/promote tools
apps/console/         React + Vite console app
apps/desktop/         Electron shell for the Mac app
apps/site/            Astro marketing and docs site
apps/playground/      Dependency-free local playground server and UI
apps/control-surface/ Local generated-signal dashboard
examples/             Mock MCP source, team demo, capture pack, and ContextCake's own layer
scripts/              Release and metrics tooling; scripts/tests/ covers it
specs/                Product and implementation specs
supabase/             Settings-sync backend for the Mac app; owned by apps/desktop/
docs/                 Architecture notes, release docs, and contributor guidance
```

The nine root `.mjs` files are the public CLI surface — `resolver.mjs`,
`mcp-server.mjs`, `classify-context.mjs`, `ingest.mjs`, `write.mjs`,
`promote.mjs`, `team-activity.mjs`, `profile.mjs`, `pack.mjs`. Each is a
three-line wrapper that calls `runCoreCli()` in
`packages/core/src/bin-shim.mjs`; canonical code lives in `packages/core/src/`.
Don't move or rename them without a documented migration path, and add a new one
by adding a `runCoreCli` call rather than re-inlining the wrapper body.

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

## Sign Your Work

ContextCake uses the [Developer Certificate of Origin](DCO) (DCO). Signing off
is how you certify that you wrote the contribution, or otherwise have the right
to submit it under this project's MIT license. There is no CLA to sign and no
copyright assignment.

Add the trailer by committing with `-s`:

```bash
git commit -s -m "fix(core): date sections from git history"
```

That appends a line matching your Git identity:

```text
Signed-off-by: Your Name <your@email>
```

Every commit in a pull request needs one, and it must match that commit's
author. Use your real name and an address you can be reached at; the sign-off
becomes a permanent part of the public history.

To sign off work you already committed:

```bash
git commit --amend --signoff --no-edit   # the most recent commit
git rebase --signoff main                # every commit on the branch
git push --force-with-lease
```

CI enforces this on every pull request. To check a branch before pushing:

```bash
bash .github/scripts/check-dco.sh main
```

Merge commits are skipped, as are commits authored by bots — Dependabot cannot
run `git commit -s`.

## Validation

Run the smallest relevant checks while developing, then run the broader gates
before opening a PR. `npm test` starts a local playground server, so it needs a
local environment where binding to `127.0.0.1` is allowed.

The suite is grouped, so you rarely need all of it while iterating:

```bash
npm run test:list          # every suite and its group
npm run test:unit          # pure units, no ports, no temp dirs
npm run test:integration   # the shell suites: sources, sync, servers
npm run test:slow          # indexing behaviour over time — the slowest group
npm test                   # everything, which is what CI runs

node scripts/test.mjs --only search   # one suite by name
node scripts/test.mjs --bail          # stop at the first failure
```

`npm test` reports every failure rather than stopping at the first, and prints
the exact rerun command for whatever broke.

### Never let a NUL byte into a source file

A single stray NUL byte makes `grep` treat a whole text file as binary: it
returns **no matches** instead of an error, so a search for a symbol comes back
empty while the symbol is right there. `service.mjs` and `main.mjs` both
carried one until #132 removed them, which hid the 2,700-line core of the engine
from every plain `grep`. This bites AI contributors hardest, since they navigate
by search and read silence as absence.

`npm test` now fails on a full run if any tracked source file contains one, so
you will hear about it before a reviewer does.

For AI contributors: state which commands you ran, include failures honestly,
and avoid broad rewrites unrelated to the issue. Agent-assisted commits are
signed off by the person submitting them — the DCO is a human certification,
so use the submitter's identity, not the agent's.
