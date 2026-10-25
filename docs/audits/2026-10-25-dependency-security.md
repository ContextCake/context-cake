# Dependency security sweep — 2026-10-25

This sweep consolidates Dependabot PRs #193, #195, #198, #202, #203, and
#204. It updates the three app dependency trees and CodeQL; the engine remains
dependency-free. Desktop package and lockfile root versions remain `0.10.0`.

## GitHub alert coverage

The initial inventory contained 18 open Dependabot alerts and no open code-
or secret-scanning alerts. Seventeen dependency alerts are covered by patched
versions in the updated lockfiles:

| Alerts | Package | Resolved version | Location |
| --- | --- | --- | --- |
| #61–#64 | Electron | 44.9.3 | Desktop development runtime |
| #65–#66 | http-cache-semantics | 4.3.0 | Site and desktop build tooling |
| #67 | brace-expansion | 1.1.21 (also 2.1.7 and 5.0.12) | Desktop build tooling |
| #68–#69 | source-map-js | 1.2.2 | Console and site |
| #71 | postcss-selector-parser | 7.1.7 | Site |
| #72 | devalue | 6.0.3 | Site |
| #73–#78 | Vite | 8.3.5 | Console and site |

GitHub's initial alert metadata listed no patch for `http-cache-semantics`,
but the published 4.3.0 version is outside the advisory's `<=4.2.0` range and
the fresh npm audits report no finding for it. The desktop copy is a build
dependency, not part of the shipped production dependency tree.

Alert #70, `sprintf-js`, refers to
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
GitHub withdrew this advisory on October 22, 2026 because handling these
formatting exceptions is an application responsibility. This is a withdrawn
finding, not a package vulnerability fixed by this PR. No fictitious patched
version or audit suppression is added. Alert #70 was dismissed as inaccurate
with the upstream withdrawal and PR #205 recorded in the dismissal note.

The npm advisory feed also reported findings beyond the GitHub inventory.
Compatible updates cover `@vitest/mocker`, `undici`, `fast-uri`, `smol-toml`,
`zod`, Sharp, Astro, and the remaining brace-expansion versions. The direct
updates include Vitest 5.0.5, Astro 7.4.2, Starlight 0.42.7, and the pinned
Supabase client 2.117.2. CodeQL moves to 4.39.0.

## Verification

Fresh `npm ci` installations and audits were run for each app. Full-tree
`npm audit --json` reports zero findings in console, site, and desktop;
desktop's separate `npm audit --omit=dev --json` also reports zero findings.
These are dated advisory-feed results, not a guarantee against future reports.

Console typechecking, all 789 tests, and the production renderer build pass.
The site builds 41 pages and passes the install-page and hidden-commerce
checks. After a fresh desktop install, all 186 tests pass, as do navigation,
CLI status, and the sandboxed boot/token smoke (`200` with authentication,
`401` without it). The 3,000-document isolation check reports 6 ms main-loop
lag against its 400 ms limit.
The root `npm test` gate passes all 76 suites, including retrieval evaluation,
release/package checks, and the indexing scale and lifecycle tests.

Use Node 22.23.4 or a compatible newer runtime for these app toolchains;
Astro 7.4.2 requires that Node 22 patch level. The dependency-free engine's
Node 22 floor is unchanged. CI and both site deployment paths select
`^22.23.4`, excluding older cached Node 22 builds. Electron's test setup now
resolves its binary serially before parallel workers start, preventing the
reproduced first-run extraction race.

Recheck with:

```bash
npm audit --prefix apps/console
npm audit --prefix apps/site
npm audit --prefix apps/desktop
npm audit --prefix apps/desktop --omit=dev
```

Patched GitHub alerts remain open on the default branch until this change is
merged and GitHub refreshes its dependency graph. Packaged-app fixes reach
users through a subsequent signed app release; this PR does not publish one.
