# ContextCake Headless Control Plane — Design

**Date:** 2026-08-11
**Status:** Drafted alongside `spec.md`; decisions in spec §8 accepted
**Spec:** `specs/contextcake-control-plane/spec.md`

How the control plane is built: a typed control-operations layer inside the
engine, with the HTTP service and the CLI as thin adapters. This document owns
technology choices; the spec owns behavior.

---

## 1. Architecture position

```
                 ┌───────────────────────────────┐
                 │  packages/core/src/control/   │   typed control operations
                 │  (new; dependency-free)       │   validation + mutation
                 └─────────┬───────────┬─────────┘
                           │           │
        service.mjs HTTP adapter   CLI adapter (bin)
        (desktop app, playground)  (contextcake <family> <cmd>)
```

- Control operations are extracted from the `service.mjs` HTTP handlers:
  source CRUD/probes/sync, settings, graph queries, discrepancies, rules,
  resolution history, file writes, section writes. Handlers become
  request-parsing shims; the CLI becomes flag-parsing shims. One validation
  path, one mutation path.
- The service's `allowMutations` gate maps onto the operations' mutation
  classes; extraction must not open a mutation path the service refuses
  today.
- Config-only operations (the existing `profile-cli.mjs` discipline,
  generalized) never construct a source adapter. Operational commands build
  one selected-profile session — sources, injected credentials, child
  processes — and tear it down in `finally`.
- Every operation takes an immutable `{profileId, manifestPath}` context; no
  operation derives a profile internally.

## 2. CLI dispatch and packaging

- The existing dispatcher (`apps/desktop/src/cli/cli.mjs`) is preserved
  through internal milestones; new families register in a command table that
  serves both dispatch and `help --json` (the help schema is generated from
  the same table that routes — they cannot drift).
- Root `.mjs` wrappers keep their existing flags and raw output; the stable
  JSON contract is an intentional pre-1.0 break for the new surface only.
- npm package `contextcake`: `files` allowlist carries `packages/core/src`,
  the bin entry, LICENSE, README — never the monorepo. `context-cake` is a
  non-executable pointer package. Both names reserved at milestone 0.
- Node `engines >=22`; CI matrix 22 and 24; the desktop build asserts the
  packaged Electron's bundled Node meets the floor (the signed app bundles
  the identical CLI under `ELECTRON_RUN_AS_NODE`).

## 3. Envelope and errors

- One envelope builder shared by every command; `--json` writes exactly one
  document to stdout, logs to stderr.
- `manifestRevision = "sha256:" + hash(stableJson(manifest))` — key-order
  independent, same rule that keeps index identity stable.
- `ControlError` fields: `code` (stable string), `message`, `details`
  (structured, pre-redacted), `retryable`, exit category. Redaction runs
  before serialization on every path, including hostile secret-shaped
  strings inside wrapped errors.
- `coverage` is computed only by read/aggregate operations and omitted
  elsewhere. Exit-code mapping lives beside the error types, tested as a
  table.

## 4. Durable state layout

- Sidecar state namespaces to `.contextcake/profiles/<profile-id>/`
  (rules, priorities, resolution history, transaction journals, recovery
  state, trust records, pending capture requests).
- Migration moves the unscoped files into `profiles/default/` via same-fs
  renames, then writes a completion marker; journal recovery runs afterward
  through its normal startup path. (Moving before recovering is equivalent to
  the reverse order because journal records carry absolute target paths — the
  journal file's own location never participates in recovery.) Re-running is
  a no-op; a crash mid-move completes on the next run; state present in both
  layouts is a refusal, never a guess — it means an older engine kept writing
  the unscoped path after a newer one migrated, and the fork needs a human.
- Profile delete retires (renames) the sidecar dir; `profile purge-state
  --confirm` deletes it.
- OS locations per spec §5.12; the macOS pair is shared with the app and
  already contractual (distribution design §5). Managed clones, Pack
  versions, pending captures, telemetry, and recovery journals live under
  data, never cache.
- Clone lifecycle: prepare in temporary durable storage → revalidate the
  manifest under lock → promote. `source remove` detaches config and keeps
  the clone; prune is a separate confirmed command refusing referenced or
  dirty clones.

## 5. Concurrency preconditions

| Resource | Precondition token |
|---|---|
| Manifest mutations | expected manifest hash (of `stableJson`) |
| File/section writes | content revision or mtime; `--force` explicit |
| Credential registry | registry revision |
| Discrepancy resolution | discrepancy revision + contributor fingerprints |
| Capture confirm | pending-request hash + profile binding + live-layer fingerprint |

Manifest mutations stay behind `withManifestLockAsync`, full-document
validation, atomic replace. `--timeout` is enforced only before the point of
no return; mutating commands refuse it otherwise.

## 6. Credential registry and backends

- Registry: locked, atomic, secret-free JSON in the config dir — per alias:
  provider, backend, allowed API/git hosts (both bindings, mirroring the
  desktop's `apiHost`/`gitHost`), revision.
- Backends are dependency-free shell-outs, present-or-typed-unavailable:
  - macOS: `/usr/bin/security` — service `com.contextcake.credentials`,
    account = alias. Always present.
  - Linux: `secret-tool` (libsecret) — application `contextcake`, alias
    attribute. Absent ⇒ `CREDENTIAL_BACKEND_UNAVAILABLE` pointing at
    `tokenEnv`.
  - Windows: no native backend in v1 (built-in tooling cannot read generic
    credentials back); `tokenEnv` only. Revisit with the Windows milestone.
- `credential add` reads via hidden TTY input; `--no-input` never persists —
  it validates `tokenEnv` references instead.
- `credential remove` and desktop Disconnect share one operation deleting
  registry row + OS secret together. Uninstall docs describe leftover
  keychain items and their removal (custody inversion mitigation, spec §8.3).
- Desktop migration from `tokens.enc`: idempotent per-entry state machine
  (`copied → verified → complete`), both host bindings carried, old store
  retained until every entry verifies, removed on a later successful
  startup. The desktop watches registry revision and reinjects
  selected-profile tokens over the existing message-port path; the renderer
  never sees secrets.
- Resolution scope: only aliases referenced by the selected profile's layers
  are resolved into the injected token map.

## 7. MCP child environment and executable trust

- Spawn env = minimal platform set (`PATH`, `HOME`, `TMPDIR`/`TEMP`,
  `LANG`/`LC_*`; `SystemRoot`/`ComSpec` on win32) + names in the source's
  `envPass` (new manifest field, strictly validated list of env var names).
  Never the parent env wholesale.
- Rollout: engine-wide, coordinated engine + desktop release with a release
  note; a post-sanitization health failure on a previously healthy source
  reports a distinct `envPass`-naming error. The CLI and app must share one
  spawn policy — it lives in the source adapter, not the adapter's callers.
- Trust records: `sha256(command + "\0" + args.join("\0") + "\0" +
  envPass.join("\0"))` stored in the profile-scoped sidecar — never the
  manifest (the manifest is the object of trust, so it cannot carry the
  trust). `source trust` writes it; any drift invalidates; interactive runs
  reconfirm; `--no-input` refuses with exit 5; CI provisions trust as an
  explicit step. Profile clone converts executable sources to pending, which
  drops trust by construction.

## 8. Capture staging (CLI path)

- `capture stage` writes an owner-only (0600) pending request into the
  profile sidecar: content hash, profile binding, live-layer fingerprint,
  expiry (default 48h).
- `capture confirm` revalidates hash + bindings + fingerprint, then writes
  through the existing capture pipeline; `capture discard` deletes only the
  request. Expired requests are inert and reaped lazily.
- The MCP server's in-process two-phase flow and tool schemas stay
  byte-identical to `packages/core/fixtures/mcp-tools-baseline.json`.

## 9. Coexistence with the running app

Every operational CLI command forks a second engine beside the app's warm one
— accepted for v1 (the CLI must work with the app closed):

- Manifest mutations are safe under contention: locked mutation + the app's
  manifest watcher pick changes up without restart.
- Config-only commands open no adapters, so most administration costs no
  duplicate indexing.
- `contextcake mcp` remains the only long-lived dual-engine case; its
  contention profile is documented at the spawn site in `cli.mjs`.
- Loopback dispatch to the running app is a tracked follow-up blocked on the
  bearer handoff design (the bearer exists only in memory and on the message
  port, by design). Out of v1; must not be absorbed silently.

## 10. Testing strategy

- Contract: parser, help-schema-from-dispatch-table, envelope, redaction
  (hostile secret-shaped errors, sentinel env vars proving neither JSON nor
  MCP children leak), exit-code table, path layout, signals, `ControlError`.
- Parity: CLI and HTTP adapters driven against the same fixtures must return
  the same operation results.
- State: every manifest mode; nested/symlinked mappings; non-default
  quarantine repair; sidecar migration (including crash-mid-migration);
  concurrent revisions; clone refcounts/dirtiness; pending sources; Pack
  assignments; profile isolation (operation in profile A provably cannot
  read B's sources or credentials).
- Writes: stale-revision refusal, dry-run diffs, discrepancy
  rollback/recovery, capture expiry/tampering/permissions, telemetry
  content-free invariant, byte-identical MCP baseline
  (`packages/core/fixtures/mcp-tools-baseline.json`).
- End-to-end: native macOS and Linux scenarios (init, source CRUD, locking,
  MCP lifecycle, credential backend present/absent, durable paths). Windows
  e2e arrives with the Windows milestone.
- Retrieval eval continues to gate `npm test`; the control plane must not
  touch ranking.

## 11. Delivery sequence

0. Reserve `contextcake` + `context-cake` on npm; approve this spec/design.
1. Extract shared control operations; sidecar namespacing + migration;
   engines → 22; CI matrix 22/24.
2. Wave A CLI: foundation, profiles, sources, settings, query, diagnostics.
3. First publication: hardening gate (OIDC trusted publishing, provenance,
   2FA, no lifecycle scripts, `files` allowlist verified by
   `npm pack --dry-run` in CI), site `/install` update, version alignment
   across root/desktop/MCP. Wave A ships as `0.x` on npm and Homebrew
   together (spec §8.5); absent families are absent, not broken.
4. Wave B as contracts freeze: writes, discrepancies, Packs, team sync,
   persistent capture approval — each family a minor release.
5. Credential broker (macOS/Linux) + engine-wide MCP env hardening +
   `source trust`, coordinated with a desktop release.
6. Agent runbooks (task-based, replacing the script catalog), harness
   recipes (Codex, Claude Code, Cursor, Claude Desktop, generic MCP, CI,
   shell), reusable `AGENTS.md`/`CLAUDE.md` snippets, dogfood, 1.0 contract
   freeze.
7. (Parallel, independently gated) Windows enablement: test-harness port or
   Windows-native e2e harness, path/lock/spawn audit, CI matrix — only then
   is Windows claimed supported.

Publication is resumable and idempotent per release tag: identical published
artifacts verify; only missing channels publish.
