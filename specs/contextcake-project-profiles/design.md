# ContextCake Project Profiles — Delivery Plan

How to deliver the approved profile model as one safe vertical slice across the
dependency-free engine, MCP server, engine service, Mac app, Console, Packs,
team sync, docs, and release validation.

**Date:** 2026-07-28
**Status:** Approved — implementation authorized 2026-07-29
**Spec:** `specs/contextcake-project-profiles/spec.md`
**Estimated shape:** five implementation PRs plus a seven-day dogfood gate

---

## 1. Outcome

At the end of this plan, a user installs ContextCake once, connects each AI
harness once, and creates profiles such as `ContextCake`, `Mind Your Blanks`,
and `Work`. Each profile contains only its relevant local folders, GitHub
sources, Packs, and optional team live layer. Starting an agent inside a mapped
folder automatically selects the matching profile.

The release is complete only when the selection is visible, deterministic, and
used consistently by every read and write path. A UI-only switcher over the
existing flat manifest is not sufficient.

## 2. Current State and Gaps

### Already present

- `files`, `okf-local`, MCP, cache, and git-sync source machinery.
- A Mac app with a bearer-protected loopback engine service, native folder
  picker, first-run source setup, CLI installation, and optional account sync.
- One global `contextcake mcp` registration flow for Claude Code, Codex,
  Cursor, Claude Desktop, and generic MCP clients.
- Pack validation, immutable retained versions, rollback, registry assignments,
  and CLI arguments that already accept `--profile`.
- Team-sync live capture, promotion, and content-free telemetry.
- An in-flight GitHub API adapter that follows the integration contract.

### Missing or incomplete

- `resolver.mjs`, `mcp-server.mjs`, and `service.mjs` still build only
  top-level `manifest.layers`.
- `resolveLiveLayer()` still searches only the flat layer array.
- Pack management can write profile layers, but the runtime cannot resolve
  them.
- Manifest reads and mutations are duplicated; Pack writes are locked and
  atomic, while service source CRUD currently writes directly.
- The Console has source setup but no profile list, active-profile state,
  project mappings, or scoped source management.
- Desktop settings sync understands profile-shaped metadata but project-path
  mappings need an explicit never-sync rule.
- Current settings sync can persist a transitional document containing both
  top-level `layers` and `profiles`, and can reconstruct scrubbed profile layers
  without their runnable path/command. Upgrade logic must accept and normalize
  that shipped shape rather than declaring it corrupt.
- `activeProfile` is currently a sync field. It must become local-only before a
  profile id can select locally trusted executable MCP sources.
- Cache directories are keyed by source name and can collide when two profiles
  reuse a layer name.
- GitHub source setup currently has two meanings: the shipped service clones a
  repo into a local cache, while the in-flight adapter reads GitHub's API. The
  UI must not present those as one indistinguishable source.

## 3. Non-Negotiable Invariants

1. **Select once.** Manifest validation and profile selection happen before any
   adapter, live layer, Pack assignment, or telemetry writer is initialized.
2. **One stack per process/request context.** No operation receives the full
   manifest after selection unless it is explicitly a configuration-management
   operation.
3. **Fail closed on an intended-but-invalid match.** An explicit or matched
   invalid profile never falls through to unrelated default context.
4. **Legacy is a first-class mode.** Reading a flat manifest causes no write and
   no behavior change.
5. **Local paths stay local.** Project mappings never enter account sync,
   telemetry, MCP responses, or logs intended for sharing.
6. **Deletion removes references, not knowledge.** Profile deletion cannot
   delete user folders, git repositories, overlays, or retained Pack versions.
7. **No new resolution rule.** Profiles choose a layer set; the existing level
   and recency rules resolve that set unchanged.
8. **The core stays dependency-free.** New core modules use Node.js built-ins.

## 4. Manifest v2 Contract

### 4.1 Canonical shape

```json
{
  "profiles": {
    "default": {
      "label": "Default",
      "layers": [
        {
          "name": "personal-notes",
          "level": 3,
          "source": "files",
          "path": "/Users/dana/Notes"
        }
      ]
    },
    "context-cake": {
      "label": "ContextCake",
      "layers": [
        {
          "name": "repo-docs",
          "level": 3,
          "source": "files",
          "path": "/Users/dana/repos/context-cake"
        },
        {
          "name": "contextcake-pack",
          "level": 0,
          "source": "okf-local",
          "path": "packs/contextcake/1.0.0",
          "origin": "pack:contextcake@1.0.0"
        }
      ],
      "pendingSources": []
    }
  },
  "projects": {
    "/Users/dana/repos/context-cake": "context-cake"
  },
  "packs": {}
}
```

Rules:

- A v2 manifest has `profiles` and no top-level `layers`.
- `default` always exists and cannot be deleted.
- Profile ids match `^[a-z0-9][a-z0-9-]{0,62}$`; labels are independent and may
  change.
- Labels are Unicode-NFC, trimmed, 1–80 display characters, and reject control
  characters, line breaks, and recognized credential patterns before they can
  enter MCP instructions, UI, logs, or sync.
- `projects` keys are absolute local paths and values are profile ids.
- Each profile contains its own complete `layers` array. v1 does not add a
  second global source registry or cross-profile layer references.
- Within a profile, the existing unique layer `name` is the v1 source identity;
  sync and migration key it with profile id and source kind. Renaming is modeled
  as remove/add and invalidates executable trust and cache identity.
- `pendingSources[]` contains synced source descriptors that are not runnable on
  this Mac. Pending sources are visible repair tasks and are never passed to an
  adapter factory, resolver, MCP server, sync operation, or live-layer lookup.
- `packs` remains a top-level retained-version registry; each assignment names
  the profile that receives the Pack layer.
- A profile may contain at most one `live: true` layer, preserving team sync's
  existing rule on a per-profile basis.

### 4.2 Legacy compatibility and migration

Reading a flat `{ "layers": [...] }` manifest returns an in-memory selection:

```js
{
  mode: "legacy",
  profile: { id: "default", label: "Default", layers: manifest.layers },
  reason: "legacy-default"
}
```

It does not write the manifest. Migration occurs only when the app needs to
persist more than one profile:

1. Acquire the shared manifest mutation lock.
2. Re-read and validate the latest manifest.
3. Classify it as flat legacy or transitional hybrid. A transitional hybrid is
   a currently shipped shape with top-level `layers` plus synced `profiles`,
   `profilesOwnerUserId`, or `pendingSources`; it continues to run the flat
   layers until this normalization.
4. Write an atomic mode-`0600` backup named with a UTC timestamp and SHA-256 of
   the source manifest. Verify the completed backup and return its path/hash in
   the migration result; never present an older unmatched backup as current.
5. Move the exact top-level `layers` array to `profiles.default.layers`. If a
   synced `profiles.default` exists, merge descriptors by stable source identity:
   locally runnable fields win and incomplete remote descriptors become pending
   rather than overwriting local execution config.
6. Preserve every existing named profile. Move any layer that lacks its required
   machine-local configuration or local executable trust into that profile's
   `pendingSources`; preserve owner-binding metadata used by settings sync.
7. Move top-level `pendingSources` into `profiles.default.pendingSources`.
8. Change every Pack assignment with `profile: null` to
   `profile: "default"`.
9. Add the new profile and any confirmed project mapping.
10. Validate the complete v2 candidate and every Pack/profile reference, write a
   mode-`0600` temporary file, and
   atomically rename it over the manifest.
11. Reload the service only after the rename succeeds.

The migration is idempotent. A crash before manifest rename leaves the legacy or
transitional manifest; a crash after rename leaves the complete v2 manifest.
Backups are never read automatically. A recovery command verifies the backup's
content hash and warns that restoring it discards changes made after its
timestamp.

### 4.3 Shared manifest module

Create `packages/core/src/manifest.mjs` as the single boundary for:

- parsing and structural validation;
- detecting legacy versus v2 mode;
- stable profile-id generation and validation;
- selecting one profile;
- listing profile summaries without opening sources;
- validating and canonicalizing project mappings;
- locked, atomic mutation and migration;
- safe layer-array access for Pack and source mutations.

Validation returns three classes instead of one undifferentiated error:

- **fatal structure:** unsafe keys, malformed profiles/layers, invalid ids, or a
  canonical v2 document with two active schema roots;
- **inactive warning:** a stale mapping, pending source, or dangling reference in
  an unselected profile;
- **selected fatal:** an explicit/matched profile, Pack assignment, or live-layer
  reference that cannot be made safe.

Move the Pack manager's private lock/write helpers into this module. Source
CRUD, profile CRUD, project mappings, and Pack operations must all use the same
lock to prevent lost updates between the app and concurrent CLI processes.

## 5. Selection Algorithm

Expose one pure selection function plus a thin filesystem canonicalization
step:

```js
selectManifestProfile(manifest, {
  requestedProfile,
  cwd,
  realpath,
}) -> {
  mode,
  profileId,
  profileLabel,
  layers,
  reason,
  matchedProjectRoot
}
```

Order:

1. Validate the manifest without opening a source, separating fatal structure
   from inactive warnings.
2. If flat legacy or transitional hybrid, return the top-level layers as the
   virtual default stack. `--profile default` reports `reason: "explicit"`;
   no override reports `legacy-default`; any other explicit id is an actionable
   migration-required error.
3. If `requestedProfile` exists, require that exact profile and return
   `reason: "explicit"`.
4. Canonicalize `cwd` and each existing mapping root with native `realpath`.
5. A root matches when `path.relative(root, cwd)` is empty or stays inside the
   root by path segments. Never use `cwd.startsWith(root)`.
6. Sort matches by canonical root depth/length descending. The longest wins.
7. If equal-specificity canonical roots point to different profiles, return a
   configuration error.
8. If the winning mapping names an unknown or invalid profile, fail closed.
9. Otherwise require and return `profiles.default` with
   `reason: "default"`.

Stale roots and dangling references in inactive profiles are returned as
warnings for the app and omitted from unrelated matching. A dangling reference
that wins selection is fatal. Paths are never emitted to shared logs or
telemetry.

### Process binding

- `contextcake mcp` selects once at startup from `--profile` and
  `process.cwd()`. It never changes profile during the process lifetime.
- `resolver`, future profile-aware commands, and `contextcake profile current`
  use the same selector.
- The desktop engine service selects from the app's persisted
  `settings.activeProfile`; it does not use the app process working directory.
- `settings.activeProfile` is local-only. Settings sync may deliver profile
  metadata but never an activation command or operative activity hint.
- A Console profile switch updates `settings.activeProfile`, tells the service
  to replace its selected adapter set, and reloads all visible data.
- Existing agent processes are unaffected by an app switch. The UI explains
  that a new agent session is required after mappings change.

## 6. Core and MCP Changes

### 6.1 Source construction

- Change `buildSources()` to receive a selected profile/layer array, or add a
  narrowly named `buildSelectedSources(selection, manifestDir, options)`.
- Prevent callers from passing a full v2 manifest without an explicit
  selection.
- Derive a non-secret source fingerprint from profile id, source kind,
  endpoint/repository or canonical local root, ref, content-path selection, and
  adapter options. Use its hash—not raw paths—in every memory/disk/API-cache
  namespace before the existing encoded display name.
- Move clone-backed GitHub checkouts from repository-slug-only paths to the same
  profile/fingerprint namespace so the same repository at different refs cannot
  share a mutable checkout. Explicit custom cache roots retain their location
  contract but receive the fingerprint subdirectory.
- Preserve adapter behavior, numeric levels, and current warn-and-continue
  semantics.

### 6.2 Resolver and compatibility wrappers

- Parse `--profile` in `resolver.mjs`.
- Select from the manifest before building sources.
- Keep root compatibility wrappers forwarding arguments unchanged.
- Update help and manifest documentation with selection order and examples.

### 6.3 MCP server

- Parse `--profile` without changing the existing boolean-flag behavior for
  `--capture` and `--telemetry`.
- Use one selection object for source construction, live-layer discovery,
  capture context, link traversal, and telemetry initialization.
- Make `resolveLiveLayer()` accept selected layers rather than search the full
  manifest.
- Add the stable profile id and non-sensitive selection reason to MCP
  initialization instructions. Return the human-readable label only as
  structured initialization metadata so synced display text cannot become
  instruction prose. Do not include a project path.
- Keep the four baseline read-tool schemas byte-for-byte stable and preserve the
  two additional team-sync read tools.
- Keep capture opt-in. The selector must complete before the server exposes
  write tools.
- Bind capture staging tokens to the selected profile id, manifest revision, and
  live-layer identity. `confirm_capture` re-reads the manifest and rejects the
  write if any binding changed or the profile was deleted.

### 6.4 Promotion

- Add a profile-aware promotion entry point that accepts `--manifest`, optional
  `--profile`, the live capture id, and a target layer name from the selected
  profile.
- Resolve source and destination roots from that one selection; do not accept
  arbitrary filesystem roots in profile-aware mode.
- Retain the current raw-path promotion CLI only as a separately documented
  legacy/advanced compatibility path. It carries no cross-profile isolation
  claim.
- Revalidate profile id, manifest revision, live-layer identity, and target
  layer before the approval write.

### 6.5 Profile CLI

Add `contextcake profile` with:

- `current [--profile <id>] [--json]` — show the selected profile and reason;
- `list [--json]` — ids, labels, source count, mapping count, and validity;
- `create <label> [--project <path>]` — headless counterpart to app creation;
- `map <id> <path>` and `unmap <path>`;
- `delete <id>` — refuse `default`, print affected references, require
  `--confirm` in non-interactive use.

Configuration commands use the shared mutation lock. `current` and `list` are
read-only and never open source adapters.

## 7. Engine Service API

Extend the bearer-protected, same-origin service with profile-aware routes.
Exact HTTP names can change during implementation if tests preserve the
semantics.

| Route | Method | Purpose |
|---|---|---|
| `/api/profiles` | GET | List profile summaries, active id, validation warnings |
| `/api/profiles` | POST | Create profile; optionally copy layers and/or map a folder |
| `/api/profiles/:id` | PATCH | Rename label or replace validated layer order |
| `/api/profiles/:id` | DELETE | Remove non-default profile references after confirmation |
| `/api/profiles/active` | POST | Change the app-selected profile and rebuild adapters |
| `/api/projects` | POST | Add or replace a canonical project mapping |
| `/api/projects` | DELETE | Remove one mapping without touching the folder |
| `/api/sources` | POST/PATCH/DELETE | Existing source CRUD with explicit profile/revision target |
| `/api/sources/sync` | POST | Sync one source with explicit profile/revision target |
| `/api/graph` | GET | Existing graph plus selected profile id/label/reason |
| `/api/resolve` | GET | Existing resolved concept in the profile/revision envelope |
| `/api/resolve-all` | GET | Existing concept set in the profile/revision envelope |

Service rules:

- Configuration-list routes parse the full manifest but never open inactive
  profile sources.
- Read routes operate on a cached adapter set keyed by manifest stamp plus
  active profile id.
- A switch creates the new adapter set before publishing it. If initialization
  fails, the prior active set remains available and the switch returns an
  error.
- Prior adapters close after the existing grace window so in-flight reads
  complete.
- Every profile-derived response—including graph, resolve, resolve-all,
  fallback reads, source sync, and configuration mutations—carries immutable
  `{profileId, manifestRevision}` metadata. The revision is a content-derived
  digest or monotonic generation, not only mtime/size.
- Every source, reorder, mapping, Pack-assignment, and delete mutation names its
  target profile explicitly and supplies the revision it read. A stale
  precondition returns `409 Conflict`; no mutation silently follows whichever
  profile happens to be active at request time.
- The renderer commits a load only after graph and resolved data share its
  expected profile/revision pair; otherwise it discards the entire generation
  and reloads.
- Source names need be unique only within a profile.
- GitHub clone source and GitHub API source receive distinct `kind` values and
  labels until the clone path is intentionally retired; the API must never
  silently reinterpret an existing source.

## 8. Desktop and Console UX

### 8.1 Persistent profile indicator

Add a compact profile control near the ContextCake brand/sidebar top:

- visible label and project/profile icon;
- tooltip/accessible name: `Active profile: <label>`;
- switcher showing label, source count, health, and mapped-folder count;
- `Manage profiles…` and `New profile…` actions;
- warning badge for stale mappings, missing sources, or a failed profile load.

The control is present only in live/Desktop mode. Demo mode keeps its current
fixed example and public behavior.

### 8.2 Profile management surface

Use Settings → Profiles as the primary management surface:

- label and stable id;
- local project-folder mappings with native picker;
- ordered source stack, source kind, health, freshness, and precedence;
- installed Pack assignments and version;
- team-sync live-layer state where present;
- rename, deliberate duplicate, and guarded delete actions.

Layer order is shown from highest precedence to lowest. Equal-level layers stay
in an explicit `same precedence; newest wins` group; drag/drop moves sources or
whole tie groups without silently converting a recency tie into a strict rank.
If levels need rebalancing, preserve tie groups and preview the exact old/new
numeric values before saving. Show a compact preview of which source wins first.

### 8.3 Creation flow

1. Enter profile label; generate a stable id and reveal it as secondary text.
2. Optionally select the local project folder.
3. Choose `Start empty` (default) or `Copy sources from…`.
4. Add the first source using the existing Markdown/ContextCake/GitHub/MCP
   source flows.
5. Optionally attach an already-installed Pack.
6. Preview source precedence.
7. Save, activate in the app, and offer `Test in my agent`.

Creating the first additional profile from a legacy stack includes a plain
migration explanation: the existing sources become `Default`; no content is
moved or deleted.

Copying a profile duplicates local layer configuration but does not copy an
executable-source trust grant: MCP commands are disabled in the copy until the
user confirms the exact command/arguments again. Synced incomplete descriptors
appear under `Needs setup`, never in the active layer order.

### 8.4 Switching behavior

- Switch optimistically only after the service accepts the new profile.
- Key graph/query state by profile id.
- Abort fetches where possible and discard any response whose profile id no
  longer matches the current selection.
- Clear selected concept, detail drawer, search query, canvas positions, and
  profile-derived counts on successful switch. Preserve theme and sidebar
  preferences.
- Announce the change through an ARIA live region and move focus predictably.
- State explicitly: `This changes the ContextCake app. Running agents keep the
  profile they started with.`
- Profile deletion adds: `Running agents may retain read access until they are
  restarted. Pending capture and promotion writes will be rejected after this
  profile is removed.` Deletion is not presented as immediate credential
  revocation.

### 8.5 Connect an Agent update

Keep the global registration commands unchanged. Add:

1. Map a project folder to the intended profile.
2. In Terminal, `cd` to that project.
3. Run `contextcake profile current` and confirm the label.
4. Start or restart the chosen harness.
5. Ask it to call `list_concepts`, identify its selected ContextCake profile,
   summarize contributing layers, and surface conflicts.

Offer explicit-profile registration only in an advanced disclosure for clients
that do not preserve a useful working directory.

Do not infer client behavior from registration scope. Before release, launch the
packaged CLI from Claude Code, Codex, Cursor, Claude Desktop, and the documented
generic-client fixture and record the actual server working directory. A client
earns the `automatic project mapping` label only if the project cwd reaches the
server reliably. Otherwise its primary copy says `uses Default`; its documented
alternative registers `contextcake mcp --profile <id>` under a separately named
server. The seven-day gate uses two clients that passed automatic-cwd proof, but
the documentation matrix covers all five advertised clients.

## 9. Packs Integration

The Pack registry already models profile assignments, but its runtime and
mutation behavior must be aligned with Manifest v2.

- Replace `selectProfileLayers()` in `pack-manager.mjs` with the shared manifest
  module.
- Add `attachInstalledPack({packId, version, profile, level})` so one retained
  immutable version can be referenced by another profile without copying or
  re-ingesting customer content.
- Keep assignments independent: two profiles may use different retained
  versions or precedence levels.
- On profile deletion, remove its Pack assignments and layer references in the
  same locked manifest transaction.
- Validate Pack state bidirectionally before mutation: each assignment's
  profile, `layerName`, `activeVersion`, and level must match exactly one profile
  layer whose `origin` names the same Pack/version, and that immutable version
  must exist in the retained-version registry. Duplicate assignments, orphan
  origins, missing layers/versions, or mismatched levels make the selected
  profile invalid until repaired.
- Garbage collection of unreferenced retained versions is out of scope and must
  never happen implicitly.
- The Console may attach/detach already-installed Packs. Download, checkout,
  entitlements, and marketplace browsing remain outside this release.

## 10. Team Sync Integration

- Change `resolveLiveLayer()` to accept the selected profile id/layers and
  return that profile id with the live-layer facade.
- Bind staged capture tokens to profile id as defense in depth, even though an
  MCP process is already profile-fixed; confirmation revalidates the current
  manifest revision and live-layer identity so a deleted profile cannot keep
  accepting writes from an old process.
- Include profile id in local capture-operation context but do not widen the
  locked shared telemetry event schema.
- Promotion uses the profile-aware entry point in §6.4. Destinations resolve by
  selected-profile layer identity; reject a target that exists only in another
  profile or changed after staging.
- The app displays live-layer sync health only for the active profile.
- Tests must prove that equal live-layer names in different profiles cannot
  cross-read, cross-write, share a cache entry, or affect each other's queued
  git state.

## 11. GitHub Source Integration Boundary

Project Profiles should consume the GitHub adapter rather than redesign it.
Before presenting `GitHub repository` as a remote profile source:

- merge and rebase the adapter against current `main`;
- preserve its read-only API, path allowlist, cache, stale-read, and
  warn-and-continue contracts;
- inject tokens by value from the desktop credential broker; the engine never
  opens the Keychain;
- use a distinct integration credential from optional ContextCake account
  sign-in;
- store only `auth: "keychain:<alias>"` in the manifest;
- support public repositories without a token and private repositories only
  after the approved GitHub device-flow/keychain path is complete;
- label the older clone-backed setup accurately if it remains available during
  transition.

The profile release is still useful with local repository folders, Obsidian,
and Markdown wiki exports. Private-GitHub auth may land as a prerequisite PR or
a clearly labeled fast-follow, but must not be simulated with a raw token field.

## 12. Account Sync and Privacy

Update the sync allowlist deliberately:

| Field | Sync behavior |
|---|---|
| Profile id and label | Allowed |
| Presentation preference | Allowed |
| Scrubbed source descriptor | Allowed under existing rules |
| Active app profile id | Local-only; remote values are ignored and no activity hint is applied |
| Project mapping/path | Never uploaded |
| Local source/cache/Pack path | Scrubbed or omitted |
| MCP command and args | Scrubbed; local reconfirmation required |
| Keychain alias/token/env value | Omitted |
| Context, prompts, captures, telemetry bodies | Never uploaded |

On a second Mac, synced profiles appear as incomplete shells whose source
descriptors live in `pendingSources` until the user maps local folders and
confirms executable sources. Pending sources are structurally valid metadata,
not runnable layers. They cannot poison another healthy profile. A remote
profile deletion removes metadata references only; local content remains
untouched.

Settings sync cannot delete or replace the local `default` runnable stack merely
because a remote snapshot omits it. A remote default deletion/invalid shape is a
sync error; complete local runnable fields survive scrub markers and profile
shell merge until the user edits them locally.

Executable MCP trust is a machine-local digest over profile id, source identity,
command, and arguments, optionally owner-bound when signed in. The digest is
never synced. Copying a profile, changing execution config, pulling a scrubbed
remote descriptor, or switching accounts invalidates trust until the source is
confirmed locally. This prevents synced ids/names from activating a preserved
local command through merge-by-identity behavior.

Project ids and selection reasons are not added to team telemetry in this
release. Dogfood measurement uses a local, manual scorecard so the privacy
contract does not expand merely to measure the feature.

## 13. Error and Recovery Model

| Failure | Required behavior |
|---|---|
| Missing/invalid manifest | Fail before opening sources; show repair guidance |
| Shipped hybrid manifest | Preserve flat runtime; offer atomic normalization |
| Unknown explicit profile | Exit non-zero; list valid profile ids |
| Mapping to unknown profile | Fail closed when that mapping matches |
| Stale/missing mapped folder | Mark warning; ignore for unrelated cwd |
| Synced source missing local config/trust | Keep pending and disabled; healthy profiles still work |
| Source fails inside selected profile | Warn and continue with healthy selected layers |
| New app profile fails to initialize | Keep prior app profile active |
| Manifest mutation lock timeout | Make no write; ask user to retry |
| Crash during migration/write | Old or complete new manifest survives; never partial JSON |
| Profile switch response arrives late | Renderer discards it by profile id/generation |
| Mutation revision is stale | Return 409; reload before the user retries |
| Pack assignment references missing version | Mark profile invalid; do not drop layer silently |
| Selected profile has multiple live layers | Disable capture for that process and show repair error |
| GitHub credential unavailable | Public read if allowed; otherwise warn and continue from safe cache |
| Synced active-profile value | Ignore; active profile is a local-only preference |

## 14. Implementation Sequence

### PR 1 — Manifest v2 selector and mutation safety

**Purpose:** establish the trust boundary before any UI writes profile data.

Primary changes:

- add `packages/core/src/manifest.mjs`;
- add schema validation, legacy view, v2 selection, realpath-safe matching,
  migration, backup, shared lock, and atomic writes;
- refactor Pack manager to use the shared manifest boundary;
- add source-fingerprint cache namespaces and Pack registry invariants;
- define transitional hybrid and per-profile pending-source normalization;
- document the Manifest v2 contract.

Validation:

- legacy manifests resolve byte-equivalently and remain unmodified;
- flat and shipped-hybrid migration fixtures preserve every layer field, named
  profile, pending/owner metadata, and Pack assignment;
- explicit/project/default selection table tests;
- nested roots, sibling-prefix traps (`/app` versus `/app-old`), symlinks,
  unknown mappings, duplicate canonical paths, forbidden keys, and lock races;
- concurrent Pack and profile mutation test proves neither update is lost;
- atomic backup/hash/retry tests prove a failed first attempt cannot make a
  stale backup look current.

### PR 2 — Runtime selection across resolver, MCP, and team sync

**Purpose:** prove every engine path uses the same selected stack.

Primary changes:

- `--profile` and automatic cwd selection in resolver/MCP;
- profile-bound live-layer discovery, capture, promotion, and telemetry context;
- profile-aware promotion command/API plus explicit legacy raw-path mode;
- dynamic profile information in MCP initialization instructions;
- complete `contextcake profile current/list/create/map/unmap/delete` CLI;
- compatibility-wrapper and CLI help updates.

Validation:

- cross-profile sentinel fixtures for search/read/list/links;
- MCP process cwd and explicit-override integration tests;
- original four tool schemas remain byte-identical;
- capture and promotion write only into selected-profile fixtures;
- profile deletion/config change between capture staging and confirmation blocks
  the write;
- same source/live-layer names in two profiles never collide;
- flat-manifest root suite remains green.

### PR 3 — Engine service and profile-scoped configuration API

**Purpose:** make safe profile management possible from the app.

Primary changes:

- add profile/project routes and profile-aware source CRUD;
- key adapter cache by manifest stamp plus active profile;
- envelope every profile-derived response and precondition every mutation with
  profile id plus manifest revision;
- preserve the prior active adapter set on failed switch;
- persist app-active profile through the desktop settings seam;
- extend loopback service tests for auth, CSRF, path validation, deletion, and
  concurrent mutation.

Validation:

- service tests exercise create/map/switch/reorder/delete end to end;
- inactive MCP sources are never spawned during active-profile reads;
- graph/resolve-all/fallback response generations cannot be mixed and stale
  mutation preconditions return 409;
- settings pulls cannot activate a local profile or executable MCP source;
- same repository/different ref clone-backed sources use distinct checkouts;
- profile deletion leaves fixture directories and retained Packs intact.

### PR 4 — Mac/Console Project Profiles UX

**Purpose:** deliver the user-visible workflow.

Primary changes:

- persistent profile indicator and accessible switcher;
- Settings → Profiles management surface;
- native project-folder mapping;
- profile-scoped source setup, health, sync, and reordering;
- installed-Pack attach/detach;
- migration explanation and guarded deletion;
- pending-source repair and local executable-trust confirmation;
- revised Connect an Agent verification flow.

Validation:

- component tests for creation, mapping, switching, stale responses, empty
  profiles, ordering, Pack assignment, and deletion confirmation;
- typecheck and both demo/live builds;
- keyboard-only, focus, 200% text, narrow-window, light, and dark checks;
- visual behavior check in the packaged Mac app, not only browser demo mode;
- launch-CWD proof for every advertised harness; clients without reliable CWD
  are accurately labeled and tested with default/explicit profile setup;
- label normalization/length/control-character/credential-pattern tests;
- public demo remains unchanged.

### PR 5 — GitHub vertical slice, docs, and release hardening

**Purpose:** prove a useful mixed-source profile and prepare the dogfood build.

Primary changes:

- land/reconcile the GitHub adapter and profile-aware cache namespace;
- finish public-repo setup and, if credential work is ready, private-repo
  device flow/keychain injection;
- distinguish remote API and clone-backed sources in UI/docs;
- update manifest, CLI, privacy, Packs, team-sync, and getting-started docs;
- create a three-profile demo fixture and dogfood runbook;
- package a signed/notarized candidate when release credentials are available.

Validation:

- root `npm test` and `npm run demo:verify`;
- Console typecheck, tests, demo build, and live build;
- desktop tests, navigation tests, CLI-status tests, smoke tests, and packaged
  app behavior;
- site build and link validation;
- fresh install plus legacy-manifest upgrade rehearsal;
- signed artifact Gatekeeper/notarization checks before distribution.

If private GitHub auth is not ready, PR 5 ships local folders plus clearly
labeled public GitHub support and records private GitHub as an unmet acceptance
gate. It must not accept pasted raw tokens as a shortcut.

## 15. Test Matrix

### Core selection matrix

| Manifest | Explicit id | CWD | Expected |
|---|---|---|---|
| Legacy flat | none | anywhere | virtual `default`, `legacy-default` |
| Legacy flat | `default` | anywhere | virtual `default`, `explicit` |
| Legacy flat | other | anywhere | error |
| V2 | valid id | mapped elsewhere | explicit id |
| V2 | none | nested mapped root | deepest mapped profile |
| V2 | none | sibling prefix only | `default` |
| V2 | none | no match | `default` |
| V2 | unknown explicit | any | fail closed |
| V2 | matched mapping to unknown id | inside root | fail closed |
| V2 | equal canonical aliases to different ids | inside root | config error |

### Isolation matrix

For two profiles containing same-named layers and unique sentinel concepts,
assert isolation across:

- source construction and MCP child spawning;
- search, read, list, and links;
- disk and memory cache;
- explicit sync;
- Pack version assignment;
- live capture staging/confirmation;
- queued git writes and promotion;
- service graph and Console state;
- response revision mixing and stale mutation preconditions;
- clone-backed GitHub checkouts for same repo/different refs.

### Migration matrix

- no Packs, one local layer;
- installed Pack with `profile: null`;
- live layer with git config;
- MCP source with command/args;
- pending/scrubbed synced source metadata;
- shipped hybrid shape with top-level layers, named profiles,
  `profilesOwnerUserId`, and top-level pending sources;
- concurrent CLI Pack update during app profile creation;
- interrupted write before and after atomic rename;
- rerun after completed migration.

Fixtures include sanitized manifests captured from the current Pack CLI,
team-sync setup, signed-in settings sync, pending-source flow, and at least one
older packaged desktop release. Synthetic shapes alone are not an adequate
upgrade corpus.

### UX matrix

- new install;
- existing flat-manifest upgrade;
- empty profile;
- nested project mapping;
- missing mapped directory;
- broken source and healthy sibling source;
- profile switch during slow graph load;
- default and non-default deletion paths;
- signed-out and signed-in settings sync;
- synced active-profile injection and profile/source id collisions;
- pending-source repair and executable trust invalidation after copy/account change;
- keyboard-only and screen-reader announcements;
- 1280px, narrow desktop, and 200% text layouts;
- light and dark themes.

## 16. Seven-Day Dogfood Plan

### Setup

Create at least three profiles with materially different context:

1. **ContextCake** — this repository, relevant local notes, ContextCake Pack.
2. **A second software/product project** — its repository and project docs.
3. **Work or personal knowledge** — a Markdown wiki export or Obsidian folder,
   with no ContextCake repository content.

Use at least Codex and Claude Code. Keep the global MCP registration identical
in both.

### Daily scorecard

Record locally, without uploading paths or content:

- harness and session number;
- expected profile and reported selection reason;
- correct/incorrect automatic selection;
- whether a manual override was needed;
- whether any unrelated concept appeared;
- whether a missing source blocked the task;
- whether provenance/conflicts changed the answer;
- setup or recovery friction in minutes.

### Pass gate

- 100% correct profile selection for mapped-project starts;
- zero cross-profile reads, cache hits, captures, or Pack assignments;
- at least 90% of mapped starts need no override;
- selected profile identifiable in under ten seconds;
- successful use from both harnesses;
- no high-severity data-loss, path-disclosure, or stuck-migration issue;
- at least one useful workflow combines two or more source layers in a profile.

The scorecard must contain at least 30 starts, at least five per profile, and at
least ten per harness. Failed starts and wrong defaults remain in the denominator;
the operator records timestamps at session start and when profile identity is
confirmed rather than estimating later.

### Decision after the trial

- If selection or trust fails, fix profiles before expanding sources.
- If selection passes but a source is repeatedly missing, build the connector
  evidenced by the scorecard.
- If daily value is weak despite correct routing, revisit the product workflow
  before investing in billing or marketplace breadth.
- If the trial passes and Packs are repeatedly useful, prioritize the first
  customer-facing Pack/install pilot next.

## 17. Rollout and Reversal

1. Merge each PR only after its slice passes the root required gate and its
   surface-specific tests.
2. Keep v2 writes behind profile-creation actions until the full app UI lands;
   flat users remain on the legacy path.
3. Dogfood with a prerelease Mac build and explicit backup verification.
4. Do not call the feature shipped until a signed/notarized artifact is tested
   on a clean install and an upgrade from a real flat manifest.
5. On a severe runtime issue, users can remove project mappings or explicitly
   invoke `--profile default`; no automatic downgrade rewrites a v2 manifest.
6. Manual recovery may restore a verified timestamped/hash-named
   `manifest.json.pre-profiles.*.json` backup only after the app is stopped and
   the current manifest is preserved for diagnosis.

## 18. Documentation Deliverables

- Manifest reference: v2 schema, legacy behavior, selection precedence, path
  privacy, examples.
- CLI reference: `profile` commands and `--profile` override.
- Getting started: create one profile, map a folder, add a source, connect once,
  verify from an agent.
- Packs: attaching one retained Pack to multiple profiles.
- Team sync: one live layer per selected profile and process binding.
- Updates and privacy: project paths never sync; second-Mac repair behavior.
- Troubleshooting: wrong profile, stale mapping, unknown profile, failed
  migration, missing source, app versus running-agent selection.
- Dogfood runbook and local scorecard template.

## 19. Definition of Done

Project Profiles are done when:

- every acceptance criterion in `spec.md` is either met or explicitly reported
  as an open release gate;
- the legacy flat-manifest suite remains green without migration-on-read;
- cross-profile isolation tests cover reads, caches, Packs, and capture writes;
- one global MCP registration routes correctly from mapped working directories;
- the Mac app supports the complete create/map/source/order/switch/delete flow;
- the packaged-app upgrade rehearsal preserves the user's existing stack;
- the seven-day dogfood gate passes;
- the canonical documentation matches the shipped artifact;
- no Slack, Confluence, Google Drive, hosted context, billing, or marketplace
  scope has slipped into the release.
