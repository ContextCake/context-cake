# ContextCake Headless Control Plane

`contextcake` becomes the complete local-product control plane for humans,
agents, automation, and CI: the UI becomes optional for setup, administration,
querying, editing, discrepancy resolution, Packs, team sync, capture, and
promotion. MCP remains the knowledge plane.

**Date:** 2026-08-11
**Status:** Signed off 2026-08-11 (§8 records the accepted decisions) —
milestone 1 of the design's delivery sequence implemented in the same change
**Workflow:** Design-First — the engine, manifest formats, profile runtime, and
distribution decisions are predetermined constraints; requirements derive from
them. Companion design: `specs/contextcake-control-plane/design.md`.
**Depends on:** `specs/contextcake-core/design.md`,
`specs/contextcake-project-profiles/spec.md`,
`specs/contextcake-distribution/spec.md` (+ its §8 npm amendments),
`specs/contextcake-packs/spec.md`, `specs/contextcake-team-sync/spec.md`,
`specs/contextcake-discrepancy-center/spec.md`,
`specs/contextcake-harness-connect/spec.md`

---

## 1. Problem Statement

The Mac app is the only complete administration surface. The shipped CLI is a
seven-command dispatcher (`mcp`, `resolve`, `ingest`, `write`, `promote`,
`pack`, `profile`) over engine entrypoints; everything else — source CRUD,
settings, credentials, file/section edits, discrepancy resolution, Pack
assignment, capture approval, diagnostics — requires the UI or hand-editing
JSON the engine treats as a trust boundary.

That excludes three audiences the product claims to serve:

1. **Headless and CI environments** — no display, no Electron.
2. **Linux users** — no desktop app exists for them at all.
3. **Shell-capable agents** — Claude Code, Codex, and Cursor can run commands,
   but today can only read through MCP; they cannot administer, reconcile, or
   safely write.

MCP deliberately stays the knowledge plane (read tools plus the existing
opt-in capture pair). General administration belongs in an explicit,
auditable CLI — never in tools an agent can invoke implicitly.

## 2. Product Terms

- **Control operation:** a typed, dependency-free function in the engine that
  validates and performs one administrative action. The HTTP service and the
  CLI are adapters over the same operations.
- **Envelope:** the versioned JSON document every `--json` invocation writes
  to stdout — schema version, ok flag, command id, context, data, warnings,
  next actions.
- **ControlError:** the typed, pre-redacted error shape carried in a failure
  envelope — stable `code`, `message`, `details`, `retryable`, exit category.
- **Command family:** a group of related commands (`source.*`, `profile.*`, …)
  that freezes its contract as a unit.
- **Stability marker:** the per-family `stable | experimental` flag exposed by
  `help --json`; only `stable` families are contractual.
- **Trust record:** the machine-local record that a specific executable MCP
  source configuration was confirmed by a human on this machine.
- **Credential registry:** a locked, atomic, secret-free index of credential
  aliases — provider, backend, allowed hosts, revision — whose secrets live in
  an OS-native store.
- **Sidecar state:** the durable `.contextcake/` directory beside the
  manifest holding rules, priorities, resolution history, journals, and
  recovery state, namespaced per profile.
- **Pending source:** a source stored as explicitly non-runnable until its
  machine-local requirements (path, command, credential, trust) are supplied.

## 3. Goals

- Make every product capability the UI offers reachable from a scriptable,
  JSON-first CLI, with the same validation and the same safety gates.
- Make the CLI safe for agents: deterministic envelopes, stable exit codes,
  machine-readable help, optimistic concurrency, dry runs, no secrets in
  output, no hidden mutations.
- Keep strict profile isolation: every operation binds to one selected
  profile; nothing reads or writes across profiles implicitly.
- Keep the engine dependency-free and the manifest trust model intact.
- Publish to npm under the already-amended hardening gate, in stages that
  deliver the headless/Linux audience early without shipping half-frozen
  contracts.
- Leave the desktop app's behavior identical where the CLI and app share
  code paths — one implementation, two adapters.

## 4. User Stories

- As a Linux or CI user with no desktop app, I can initialize, add sources,
  set precedence, query, and diagnose entirely from the shell.
- As an agent in a shell-capable harness, I can inspect `help --json`, run
  `doctor` and `profile current`, and administer sources with `--json
  --no-input`, trusting exit codes and revisions instead of prose.
- As a desktop user, I can script bulk changes with the CLI while the app is
  running and watch them land in the UI without restarting anything.
- As a cautious operator, I can dry-run any write, see a diff, and know a
  stale revision fails loudly instead of clobbering newer work.
- As a security-minded operator, I know a foreign MCP server only ever sees
  the environment variables I explicitly passed it, and that changing its
  command invalidates my earlier trust decision.
- As a team member, I can stage, review, confirm, or discard captures and
  promotions from the shell with the same show-before-share gate MCP capture
  has.
- As a Windows user, I can run the CLI best-effort with `tokenEnv`
  credentials, and I am told plainly which guarantees are not yet tested
  there.

## 5. Acceptance Criteria

### 5.1 CLI contract and envelope

- [ ] WHEN any command runs with `--json` THE SYSTEM SHALL write exactly one
  uncolored JSON document to stdout, route all logs and progress to stderr,
  and include `schemaVersion`, `ok`, `command`, `context`, `data`,
  `warnings[]`, and `nextActions[]`.
- [ ] WHEN the envelope reports `context.manifestRevision` THE SYSTEM SHALL
  derive it from the `stableJson` serialization so a rewrite that only
  reorders keys never changes the revision.
- [ ] WHEN a command fails THE SYSTEM SHALL return `ok:false`, `data:null`,
  and a ControlError with a stable `code`; context fields MAY be `null` only
  when failure precedes manifest/profile selection.
- [ ] WHEN any error, log, or envelope is produced THE SYSTEM SHALL redact
  secret values before serialization; secrets SHALL never appear in argv,
  manifests, JSON output, logs, or telemetry. Redaction covers three
  testable classes: (a) exact-match scrubbing of every value obtained from a
  credential source (registry-resolved secrets, `tokenEnv` values, the
  injected token map) anywhere it appears in an error or output, (b) strings
  matching known provider token prefixes (e.g. `ghp_`, `github_pat_`,
  `sk-`, `AKIA`), and (c) `Authorization`-header values.
- [ ] WHEN `help --json` runs THE SYSTEM SHALL enumerate canonical command
  IDs, accepted inputs, mutation class, required preconditions, possible
  error codes, output schema, and the per-family stability marker.
- [ ] WHEN `mcp` is invoked THE SYSTEM SHALL accept only its documented
  serving flags and reject `--json`, `--quiet`, `--timeout`, and any other
  flag that could corrupt or half-kill a long-lived stdio session.
- [ ] WHEN `account status` runs in an accounts-disabled build THE SYSTEM
  SHALL exit `0` and report a typed "disabled in this build" state rather
  than omitting the command (§8.6).
- [ ] WHEN `--timeout` is supplied to a mutating command THE SYSTEM SHALL
  refuse it with exit `2`, except for mutating commands whose design
  explicitly accepts it, where it SHALL be enforced only before the point of
  no return; a timeout SHALL never abort between a journal write and its
  completion marker.

### 5.2 Exit codes and coverage

- [ ] WHEN a command exits THE SYSTEM SHALL use: `0` success, `1` internal,
  `2` invalid input, `3` uninitialized/not found, `4`
  conflict/precondition/confirmation (ControlError `code` distinguishes
  stale-revision from confirmation-required), `5`
  permission/trust/credential, `6` unavailable/network/timeout, `7`
  integrity/recovery required, `8` unhealthy diagnostics, `130` interrupted.
- [ ] WHEN a warn-and-continue read completes partially THE SYSTEM SHALL exit
  `0` with `coverage.complete:false` naming the degraded sources; WHEN
  `--require-complete` is set, or the command is an explicit `source test` or
  `source sync`, THE SYSTEM SHALL exit `6` instead.
- [ ] WHEN a command is config-only or mutating THE SYSTEM SHALL omit
  `coverage` rather than fabricate it; coverage appears only on
  read/aggregate commands.

### 5.3 Profiles and isolation

- [ ] WHEN a profile-aware command runs THE SYSTEM SHALL select exactly one
  profile with precedence `--profile` > project mapping from `--cwd`/cwd >
  `default`, carry that identity immutably through every control operation,
  and never open another profile's sources or credentials.
- [ ] WHEN `profile show|rename|clone|purge-state` run THE SYSTEM SHALL
  extend the existing `current|list|create|map|unmap|delete` set without
  changing their behavior; rename changes only the label, never the id.
- [ ] WHEN a profile is cloned THE SYSTEM SHALL copy configuration but
  convert executable MCP sources into pending sources requiring renewed
  local trust.
- [ ] WHEN a profile is deleted THE SYSTEM SHALL retire its sidecar state
  directory without deleting it; `profile purge-state --confirm` SHALL be the
  separate destructive action.
- [ ] WHEN sidecar state exists unscoped from before namespacing THE SYSTEM
  SHALL migrate it to `.contextcake/profiles/default/` via same-filesystem
  renames before any store access, with journal recovery running afterward
  through its normal startup path (equivalent to recovering first, because
  journal records carry absolute target paths — the journal file's own
  location never participates in recovery); a migration interrupted by a
  crash SHALL complete on the next run, and state present in both layouts
  SHALL be refused, never merged by guess.

### 5.4 Sources

- [ ] WHEN `source add|update|remove|level|test|sync` run THE SYSTEM SHALL
  reuse the same validation and mutation code the desktop service uses,
  including cheap add-time validation, quarantined reads, strict writes, and
  the all-or-nothing removal rule with its 409-style listing.
- [ ] WHEN `source reorder` runs THE SYSTEM SHALL require the complete
  current source-name list for the selected profile, assign unique
  descending levels deterministically, update Pack assignments, and refuse
  with a 409-style listing when quarantined layers exist in that profile.
- [ ] WHEN `source pending list|configure|dismiss` run THE SYSTEM SHALL
  surface pending sources and let the user supply the missing machine-local
  requirements or discard the entry, without ever activating a pending
  source implicitly.
- [ ] WHEN config-only commands run THE SYSTEM SHALL never open a source
  adapter; WHEN operational commands run THE SYSTEM SHALL open one
  selected-profile session and close every source and child process in
  `finally`.

### 5.5 Settings and credentials

- [ ] WHEN `settings list|get|set|reset` run THE SYSTEM SHALL operate through
  the existing settings catalog and precedence (manifest > env > default).
- [ ] WHEN `credential add` runs interactively THE SYSTEM SHALL read the
  secret via hidden input and store it only in the OS-native backend (macOS
  `/usr/bin/security`; Linux `secret-tool` when present); the registry SHALL
  hold alias, provider, backend, allowed API/git hosts, and revision — never
  the secret.
- [ ] WHEN no native backend is available (headless Linux without libsecret;
  Windows in v1) THE SYSTEM SHALL fail `credential add` with typed
  `CREDENTIAL_BACKEND_UNAVAILABLE` pointing at source-level `tokenEnv`;
  nothing SHALL degrade silently.
- [ ] WHEN `credential remove` runs — from the CLI or the desktop's
  Disconnect — THE SYSTEM SHALL delete both the registry row and the OS
  secret through the same shared operation.
- [ ] WHEN `credential test` runs THE SYSTEM SHALL contact only hosts pinned
  in that registry entry, never a host taken from the manifest at test time.
- [ ] WHEN the Mac app migrates `tokens.enc` THE SYSTEM SHALL use an
  idempotent copied/verified/complete state machine, carry both recorded
  host bindings (`apiHost`, `gitHost`), retain the old store until every
  entry verifies, and remove it only after a later successful startup.
- [ ] WHEN the credential registry revision changes THE desktop SYSTEM SHALL
  reinject selected-profile tokens without exposing them to the renderer;
  only aliases referenced by the selected profile SHALL be resolved.

### 5.6 Executable trust and MCP child environment

- [ ] WHEN the engine spawns a foreign MCP source THE SYSTEM SHALL provide a
  minimal platform environment (`PATH`, `HOME`, `TMPDIR`/`TEMP`,
  `LANG`/`LC_*`, plus `SystemRoot`/`ComSpec` on win32) plus exactly the
  names declared in that source's `envPass` list; children SHALL never
  inherit the parent environment wholesale.
- [ ] WHEN a source that previously passed health fails after environment
  sanitization lands THE SYSTEM SHALL surface a distinct error naming
  `envPass`, not a generic spawn failure.
- [ ] WHEN `source trust` runs THE SYSTEM SHALL record a hash of the source's
  `command`, `args`, and `envPass` in the profile-scoped sidecar state —
  never in the manifest; any change to those fields SHALL invalidate the
  record.
- [ ] WHEN an untrusted executable source is encountered THE SYSTEM SHALL
  reconfirm interactively, refuse with exit `5` under `--no-input`, and
  accept an explicit `source trust` invocation as the CI provisioning path.
- [ ] WHEN environment sanitization ships THE SYSTEM SHALL ship it
  engine-wide in a coordinated engine + desktop release with its own release
  note; the CLI SHALL NOT carry a different spawn policy than the app.

### 5.7 Knowledge and safe writes

- [ ] WHEN `concept list|search|read|links` and `file list|read` run THE
  SYSTEM SHALL answer through the existing resolver, search, and layer-file
  operations with identical results to the HTTP API.
- [ ] WHEN `file write` or `section write` run THE SYSTEM SHALL take content
  from stdin or `--content-file` (never argv), support `--dry-run` diffs,
  and require the expected content revision or mtime unless `--force` is
  explicit.
- [ ] WHEN any file/section write targets a path THE SYSTEM SHALL enforce the
  same layer-root sandbox (`assertInsideRoot`) the service enforces.

### 5.8 Reconciliation

- [ ] WHEN `discrepancy list|show|summary|resolve|batch|priority`, `rule
  list|suggestions|approve|update|remove|promote`, and `resolution log` run
  THE SYSTEM SHALL reuse the existing discrepancy, rule, priority, and
  transaction-journal machinery, including rollback/recovery and
  contributor-fingerprint checks; resolution SHALL require the expected
  discrepancy revision; `discrepancy batch` SHALL read its decisions from
  stdin or `--file` (never argv), support `--dry-run` (per-item
  `wouldWrite`, nothing written) and `--stop-on-error`, and answer per-item
  results with the same `applied`/`failed` counts the HTTP route answers.
  (Engine side shipped 2026-08-18 as
  `packages/core/src/control/discrepancies.mjs` —
  `createDiscrepancyOperations(caps)` with `decide`, `decideBatch`,
  `runAutomaticRules`, the HTTP service is a shim over it; the CLI adapter
  is pending.)

### 5.9 Packs

- [ ] WHEN `pack attach|detach|level` run THE SYSTEM SHALL manage
  multi-profile Pack assignments through the same manifest mutation path,
  with existing `pack` commands unchanged.

### 5.10 Team memory and capture

- [ ] WHEN `capture stage` runs THE SYSTEM SHALL persist an owner-only
  (0600), expiring pending request (default 48h) in the profile-scoped
  sidecar state, containing the content hash and profile/live-layer binding.
- [ ] WHEN `capture confirm` runs THE SYSTEM SHALL revalidate the pending
  request hash, profile binding, and live-layer fingerprint before writing;
  `capture discard` SHALL remove only the pending request.
- [ ] WHEN CLI capture ships THE MCP server's in-process two-phase
  stage/confirm and its tool schemas SHALL remain byte-identical to the
  committed baseline.
- [ ] WHEN `team status|activity|sync|telemetry` run THE SYSTEM SHALL reuse
  the existing team-sync and telemetry operations with their content-free
  telemetry invariant intact.

### 5.11 Harness integration

- [ ] WHEN `harness instructions <client>` runs THE SYSTEM SHALL emit the
  current absolute executable and exact installed version; ephemeral paths
  (translocated app, npx cache) SHALL never reach a harness configuration,
  and `npx` SHALL appear only as a version-pinned bootstrap option.
- [ ] WHEN `harness verify` runs THE SYSTEM SHALL perform initialization,
  expected-profile, tool-list, and `list_concepts` checks without editing
  third-party configuration.

### 5.12 Durable state and paths

- [ ] WHEN the CLI needs config, data, or cache locations THE SYSTEM SHALL
  use: macOS `~/Library/Application Support/ContextCake` +
  `~/Library/Caches/ContextCake` (shared with the app, already contractual);
  Linux XDG (`~/.config/contextcake`, `~/.local/share/contextcake`,
  `~/.cache/contextcake`); Windows `%APPDATA%\ContextCake` +
  `%LOCALAPPDATA%\ContextCake\{Data,Cache}`; honoring
  `CONTEXTCAKE_CONFIG_DIR`, `CONTEXTCAKE_DATA_DIR`, `CONTEXTCAKE_CACHE_DIR`,
  and `CONTEXTCAKE_MANIFEST` overrides.
- [ ] WHEN classifying storage THE SYSTEM SHALL treat managed clones, Pack
  versions, pending captures, telemetry, and recovery journals as durable —
  never cache.
- [ ] WHEN `source remove` runs THE SYSTEM SHALL detach configuration but
  retain managed clones; a separate confirmed prune SHALL refuse referenced
  or dirty clones and never delete dirty data automatically.
- [ ] WHEN git clones are prepared THE SYSTEM SHALL stage them in temporary
  durable storage and promote them only after manifest revalidation under
  lock.

### 5.13 Platform and runtime

- [ ] WHEN the package declares runtime support THE SYSTEM SHALL require
  Node 22+ (`engines` bumped from `>=18` in the same change, CI matrix
  pinned to 22 and 24) and SHALL verify the packaged Electron's bundled Node
  satisfies the same floor.
- [ ] WHEN running on win32 THE SYSTEM SHALL run best-effort (no hard
  platform blocks, path-separator-safe code) while documentation claims
  support only for macOS and Linux until the Windows milestone's CI matrix
  is green.
- [ ] WHEN manifests are read THE SYSTEM SHALL preserve legacy, transitional,
  and v2 forms; `init` SHALL create v2; nothing SHALL migrate on read.

### 5.14 Release and publication

- [ ] WHEN the first npm publication occurs THE SYSTEM SHALL have satisfied
  the distribution spec's hardening amendment: OIDC trusted publishing from
  a protected GitHub environment, automatic provenance, 2FA, token
  publishing disabled, no lifecycle scripts, and a minimal `files`
  allowlist verified via `npm pack --dry-run` in CI — and SHALL update the
  site's install messaging in the same release (the "Why a source archive?"
  section of `apps/site/src/content/docs/docs/getting-started/installation.md`
  and `apps/site/src/pages/install.astro`, which currently explain why npm is
  unavailable).
- [ ] WHEN a wave publishes THE SYSTEM SHALL include only contract-complete
  families in the dispatcher (absent, not broken); `help --json` stability
  markers SHALL govern what agents may rely on.
- [ ] WHEN a release tag is re-run THE SYSTEM SHALL verify already-published
  identical artifacts and publish only missing channels (resumable,
  idempotent, coordinated).
- [ ] WHEN any publication occurs THE SYSTEM SHALL have aligned root,
  desktop, and MCP versions (root `package.json` currently 0.1.0 against a
  0.7.x app) and built every release artifact before publishing any channel.
- [ ] WHEN a release candidate exists THE SYSTEM SHALL be dogfooded with
  Codex, Claude Code, direct shell automation, at least three profiles,
  degraded-source scenarios, and concurrent desktop use, with no manual UI
  intervention, before the wave is declared supported.

## 6. Out of Scope

- **Windows as a supported tier** — parallel, independently gated milestone
  (test-harness port, path/lock/spawn audit, CI matrix). Best-effort only in
  v1; no native credential backend there.
- **Dispatching CLI calls to a running app's loopback service** — tracked
  follow-up blocked on the bearer handoff design; v1 accepts second-engine
  semantics explicitly.
- **General administrative MCP tools** — administration stays in the CLI.
- **Account OAuth, account deletion, desktop self-update** — owned by the
  signed Mac app; the CLI exposes status and guidance only.
- **Commerce** — no payment, entitlement, or checkout surface in the CLI.
- **Knowledge-resolution behavior** — owned by `contextcake-core`; unchanged.

## 7. Boundaries

- ✅ **Always:** one implementation — CLI and HTTP service adapt the same
  control operations; identical validation, identical mutation gates. Always
  run the retrieval eval with `npm test`; a ranking regression fails the
  build. Always close sources and child processes in `finally`.
- ✅ **Always:** route secrets through the registry/backends or `tokenEnv`;
  emit logs to stderr; keep `--json` stdout a single document.
- ⚠️ **Ask first:** before adding any npm runtime dependency anywhere in
  `packages/core` (it stays dependency-free — credential backends are
  shell-outs or typed-unavailable); before changing exit-code or envelope
  semantics after a family is marked stable; before widening the minimal MCP
  child environment set.
- 🚫 **Never:** commit secrets or write a secret into argv, manifest, JSON
  output, log, or telemetry; store trust records in the manifest; let the
  CLI's spawn policy diverge from the app's; publish npm with lifecycle
  scripts or token-based auth; break the byte-identical MCP tool baseline;
  delete dirty clone data automatically; ship a mutation that can abort
  between a journal write and its completion marker.

## 8. Resolved Decisions

Accepted by John 2026-08-11 (plan-approval session):

1. **Staged publication.** Wave A (foundation, profiles, sources, settings,
   query, diagnostics) publishes first behind the hardening gate; later
   families land as minors when their contracts freeze. Incomplete families
   are absent from the dispatcher. (Fallback if reversed: collapse milestones
   3–4 into one release; no other changes.)
2. **Windows demoted** to a parallel, independently gated milestone; v1
   supports macOS + Linux, win32 best-effort. Consistent with the
   distribution spec's "incidentally cross-platform" posture.
3. **Keychain custody inversion.** `tokens.enc` migrates into OS-native
   stores despite the prior "never let a token reach the login keychain"
   doctrine; mitigations are contractual (§5.5): shared delete path, host
   bindings carried, uninstall documentation.
4. **Node engines `>=22`** on the published package (bumped from `>=18` in
   the milestone-1 change).

Inherited from `specs/contextcake-distribution/spec.md` §8: npm name
`contextcake` with `context-cake` reserved as a pointer package; npm gated
behind the supply-chain-hardening review; site `/install` updated in the same
release.

Resolved 2026-08-11 (spec sign-off session):

5. **Homebrew ships in the same wave as npm** — one release publishes both
   channels together.
6. **`account status` exists with a typed "disabled" state** while builds
   ship accounts-disabled, reporting that accounts are disabled in this
   build rather than omitting the family.

## 9. Open Questions

None — all markers resolved (§8).

## 10. Dependencies

- The specs listed in the header, especially the profiles selection contract
  and the distribution hardening amendments.
- npm registry (names `contextcake` + `context-cake` — reserve at milestone
  0), protected GitHub environment for OIDC publishing.
- macOS `security(1)`; Linux `secret-tool` (optional, degraded path defined).
- The desktop app for the `tokens.enc` migration and coordinated
  env-sanitization release.

## 11. For the Implementing Agent

**Commands:** see root `CLAUDE.md` (authoritative). `npm test` from repo root
runs the full chain including the retrieval eval; single suites via
`bash packages/core/tests/<suite>.sh` or `node --test packages/core/tests/<t>.mjs`.

**Testing:** bash + `node --test` under `packages/core/tests/`; temp dirs with
`trap` cleanup; run from repo root. Aggregate-read assertions must pass
`?wait=<ms>`. New CLI tests follow the same patterns; parity tests drive CLI
and HTTP adapters against identical fixtures.

**Project structure:** control operations land in `packages/core/src/control/`
(new); the CLI entry extends the existing dispatcher; root `.mjs` wrappers
keep their flags and raw output; `apps/` packages never import from each
other; app → engine imports stay one-way.

**Code style:** ESM `.mjs`, plain Node built-ins only in `packages/core`;
match surrounding idiom; comments state constraints, not narration.

**Git workflow:** conventional commits; branch per milestone; specs are
committed, plans (`docs/plans/`) never are; never `--no-verify`; PRs to
`main`.

**Boundaries:** §7 above. The single highest-signal constraint: never let a
secret reach argv, manifest, JSON, log, or telemetry.

**Self-verification (run before claiming done):**
> Compare your implementation against §5 of this spec and list any acceptance
> criteria not addressed.
