# Maintenance review — 2026-11-06

The sections through "Validation and limits" record the initial read-only
assessment on November 6. At that point no dependencies had changed and nothing
had been pushed, published, or deployed. Implementation follow-through is
recorded separately below.

## Current baseline

- Local checkout matches GitHub `main` at `47d260c` (October 28).
- Latest signed release: [app-v0.10.1](https://github.com/ContextCake/context-cake/releases/tag/app-v0.10.1),
  published October 28 from `02415ef8a34b28ea013218dce034208e05ca7a8f`.
- The only two commits after that release configure Dependabot grouping,
  cooldown, and automatic merging; there is no unreleased product change on main.
- GitHub returned no open PRs or issues and no open Dependabot, CodeQL, or
  secret-scanning alerts. This does not replace a fresh dependency audit.
- Latest main CI and November 2 scheduled CodeQL passed. November 3 Dependabot
  update jobs succeeded.
- The existing `scripts/verify-release-surfaces.mjs` passed against the canonical
  site and Web Demo for 0.10.1. The Web Demo provenance names the release commit.
  A search-engine copy of the install page was stale; direct HTTP checks were used
  for the current result. The committed site release record is refreshed during
  deployment and is not proof of the live version.

## Recommended work, in order

### 1. Address the desktop build dependency advisory

Fresh lockfile audits report zero findings for console, site, and desktop
production dependencies. Desktop's full tree reports six moderate affected
packages, all stemming from one advisory:
[minimatch glob-pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).

The lockfile contains minimatch 10.2.6 under app-builder-lib and 9.0.9 under
@electron/universal. The advisory affects versions 7 through 11.0.0; 11.0.1 is
patched. These are build dependencies; this finding does not establish a shipped
runtime vulnerability or an exploitable path in ContextCake's packaging config.

electron-builder 26.18.0 is still the latest published version. npm audit's
suggested move to electron-builder 25.1.0 is a downgrade, not a maintenance plan.
Evaluate an upstream fix or a narrowly scoped override with compatibility and
packaging checks. Do not run `npm audit fix --force` to accept that downgrade.

### 2. Close two existing concurrency gaps

- **Manifest stale-lock recovery:** `packages/core/src/manifest.mjs` still parks
  and restores lock paths with rename. The October owner-generation fix remains
  present, but the separate three-contender path-vacancy/restore race documented
  in `2026-10-25-dependency-security.md` is still unresolved. Treat this as a
  concurrency protocol change requiring a deterministic regression, rather than
  assuming the existing two-owner tests cover it.
- **Live-layer editor writes:** `writeFileApi` and `writeSectionApi` in
  `packages/core/src/layer-files.mjs` still write directly. The corresponding
  routes in `service.mjs` do not use the git mutation coordinator that discrepancy
  decisions use. Route live-layer edits through the existing repository lock and
  commit path; verify that held locks leave bytes unchanged and concurrent edits
  cannot interfere with decision commits.

### 3. Group compatible dependency updates

Versions below were queried directly from npm and compared with committed
lockfiles; no installation was performed.

| App | Package | Locked | Latest |
| --- | --- | --- | --- |
| Desktop | electron | 45.1.0 | 45.2.3 |
| Desktop | @supabase/supabase-js | 2.118.0 | 2.119.0 |
| Console | @vitejs/plugin-react | 6.1.2 | 6.2.1 |
| Console | vite | 8.3.5 | 8.3.6 |
| Console | vitest | 5.0.5 | 5.1.0 |
| Site | astro | 7.4.2 | 7.4.7 |
| Site | @astrojs/starlight | 0.42.7 | 0.42.9 |
| Site | @astrojs/markdown-remark | 7.3.4 | 7.3.6 |
| Console | jsdom | 30.1.3 | 31.0.0 |

Keep the jsdom major separate if it requires migration work. Supabase is lower
urgency while accounts remain disabled. React, TypeScript, electron-updater,
electron-builder, Sharp, fonts, and sitemap were already at their latest direct
versions. The engine remains dependency-free.

### 4. Review the npm release gap

The public `contextcake` npm package and `latest` tag are still 0.10.0. The signed
0.10.1 release already contains its tarball. No npm staging workflow for 0.10.1
appears in the workflow history inspected; the latest run is from September 20.

Use the existing staged-publishing and approval process in `docs/go-live.md`,
then refresh the site after publication. This review does not authorize those
release actions. A new app release is not necessary merely to publish the
already released npm artifact.

### 5. Make a small UI and documentation maintenance pass

The original checkout has an untracked `BACKLOG.md`. Current source confirms:

- `handleTrustedIpc` appends trusted context after renderer arguments, while
  some handlers expect context first. Current preload arities make that work;
  harden the convention before adding parameters to those channels. This is a
  fragile interface, not a demonstrated present exploit.
- `CliControl` fetches status on mount and after its own install action. A menu
  installation does not notify an already open Settings renderer. Refresh on
  focus or propagate the status change.
- `ShortcutsReference.tsx` still names Home, Cascade, Knowledge, and Review while
  the menus use Workspace, Map, Library, and Trust. Keep the labels and chords
  synchronized with the real bindings.
- `.cc-settings-subhead` remains 11px text on `--cc-faint`. The default light and
  dark palette tokens yield insufficient small-text contrast against the raised
  surface. Verify actual computed surfaces when correcting it; old backlog
  contrast numbers should not be reused as current measurements.

The October 30 branch `docs/readme-portfolio-pass` has one local commit,
`ea8ceef`, explicitly marked as an unpushed draft. Review that existing README
rewrite before starting another. No other worktree or untracked file was changed.

The top-level instructions also describe search-store as not yet connected,
although `service.mjs` and `retained-search.mjs` import and use it. Correct that
instruction drift. Do not reopen the September performance/UX audit wholesale:
its implementation record and current code already address retained search,
honest Ask handoff, Markdown link examples, and several reading/search issues.

## Validation and limits

- Fresh npm lockfile audits and direct-version queries completed on November 6.
- Canonical release surface verifier passed for 0.10.1.
- Full engine gate: **76/76 suites passed** on Node 22.23.4 in 549.1 seconds,
  including retrieval evaluation, release/package checks, and indexing stress
  tests. Retrieval evaluation reported no regression against its baseline.
- The initial sandboxed test attempt was invalidated by blocked loopback binds
  and stopped. The replacement uses Node 22.23.4 with loopback access.
- App dependencies are not installed in this worktree. Console/site builds,
  desktop unit tests, native UI, packaging, and optional `smoke:ui` were not
  rerun. Revalidate the optional UI smoke harness before relying on it for a
  future release.

Suggested delivery: one compatible dependency/build-security maintenance PR,
focused fixes for the two concurrency gaps, and a small UI/docs follow-up. Review
the existing README draft and the npm publication gap as separate decisions.


## Implementation follow-through

The maintenance work is split into two reviewable branches; no merge or public
release is part of this pass.

| Initial item | Resolution |
| --- | --- |
| Desktop build advisory | Pin minimatch 11.0.1 overrides only under app-builder-lib and @electron/universal; full desktop audit is clean and a local arm64 Mac app packages successfully. |
| Manifest and live-editor concurrency | [PR #213](https://github.com/ContextCake/context-cake/pull/213): unique directory owner claims, safe legacy refusal, locked/journaled editor writes, exact index rollback, normalized path/alias coverage, and startup recovery serialization. Native restart additionally uses async bootstrap and immediate confirmed-dead-claim recovery. |
| Dependency updates | All listed direct updates, including jsdom 31, are installed and locked. Console test workers are capped at four to avoid resource-driven timeouts on hosts with many cores. |
| IPC context | Trusted context is always argument zero; all payload handlers migrated; hostile extra renderer arguments are covered. |
| CLI status | Settings refreshes on focus and ignores older asynchronous status responses. |
| Shortcuts and contrast | Settings uses the same digit navigation table as the shell, checked against native menu chords/labels. Native Diagnostics digit routing works. Small Settings subheadings use the body token, whose 4.5:1 reading pairs are covered across themes. |
| Optional UI smoke | Waits for lazy screens and current selectors. A discovered first-mount Settings pane persistence race is fixed. Standard smoke commands now use temporary profiles and logs. |
| README/instruction drift | Reused the October 30 draft and corrected platform, source permission, date fallback, network, and vendored-code claims. Corrected search-store wiring instructions. Original draft worktree and unrelated untracked files are untouched. |
| npm 0.10.1 | Tarball contents, SHA-256 checksum, SHA-512 integrity, and app-release workflow attestation verified. The existing workflow passed verification and is waiting at its environment approval gate; nothing staged or published. See the [approval packet](2026-11-06-npm-0.10.1-approval.md). |

Validation for the maintenance branch on Node 22.23.4:

- Console: 792 tests pass; typecheck and live renderer build pass.
- Desktop: 187 tests pass; navigation, CLI status, boot/token guard, relaunch,
  and complete responsive UI smoke pass. UI smoke reports zero renderer errors.
- Isolation: 4 ms main-process lag while indexing 3,000 documents, below its
  400 ms limit; status p95 10 ms over 45 probes.
- Site: 41 pages build; install and hidden-commerce checks pass.
- Fresh full-tree npm audits: zero findings in all three apps.
- Local unsigned arm64 Mac packaging and packaged boot/token smoke pass
  (`200` authenticated, `401` unauthenticated, sandbox on, zero engine probe
  failures). Nothing installed or distributed.
- Engine/release gate: all 76 suites pass. The full run passed 75; the lifecycle
  suite stopped at preflight because its fixed port was occupied, then passed
  alone using its supported alternate-port setting.
- Code, security, and documentation reviews run independently; all actionable
  findings were addressed.

The data-integrity branch separately passed 77 engine suites, 19 final
editor/recovery tests, 27 manifest tests after the native-restart and Windows-contention corrections,
and all 186 desktop tests. CI status is tracked on the PR, not frozen here.
