# ContextCake Project Profiles

Project Profiles let one ContextCake installation serve the correct, isolated
source stack for each local project. A user connects an AI harness once; when
the harness starts inside a mapped project folder, ContextCake selects that
project's profile automatically and exposes only its sources, Packs, live
captures, provenance, and conflicts.

**Date:** 2026-07-28
**Status:** Approved — implementation authorized 2026-07-29
**Workflow:** Requirements-First delivery slice of the approved profiles work in
`specs/contextcake-integrations/spec.md`
**Depends on:** `specs/contextcake-core/design.md`,
`specs/contextcake-integrations/spec.md`,
`specs/contextcake-distribution/design.md`,
`specs/contextcake-harness-connect/spec.md`,
`specs/contextcake-packs/spec.md`, and
`specs/contextcake-team-sync/spec.md`

---

## 1. Problem Statement

ContextCake can already resolve layered local knowledge, connect to AI
harnesses, install Packs, and maintain a git-backed live layer. Today those
capabilities still assume one flat `layers[]` stack. A user working across
multiple projects must either combine unrelated context into that one stack or
manually maintain separate manifests and MCP registrations.

That breaks the core product promise in two ways:

1. **Relevance:** an agent working on Project A can receive noise from Project
   B, increasing token use and making the resolved answer less useful.
2. **Trust:** unrelated or sensitive context can cross a project boundary. A
   profile mistake is therefore not just inconvenient; it is a data-isolation
   failure.

Project Profiles make the local project folder the automatic routing signal.
Each profile owns an explicitly ordered layer stack. The Mac app makes the
active profile visible and manageable, while `contextcake mcp` selects a
profile from the harness working directory without requiring another MCP
registration.

## 2. Product Terms

- **Project profile:** a stable profile id, human-readable label, and ordered
  list of ContextCake layers.
- **Project mapping:** a machine-local association from an absolute folder path
  to a project profile.
- **Selected profile:** the single profile chosen for one engine or MCP process.
- **Active profile:** the profile currently displayed by the Mac app. This is a
  UI preference; it does not override working-directory selection in an agent.
- **Default profile:** the required fallback profile when no explicit profile or
  project mapping applies.
- **Legacy stack:** an existing manifest containing top-level `layers[]` and no
  `profiles` object. It behaves as a virtual default profile until the user
  creates another profile.

## 3. Goals

- Let a user create and manage separate source stacks for separate projects.
- Let a globally registered MCP server choose the correct stack from the
  harness working directory.
- Make the selected profile and selection reason inspectable before the user
  trusts an answer.
- Guarantee that reads, searches, links, sync, Packs, live capture, promotion,
  and telemetry all operate on the same selected stack.
- Preserve existing flat manifests without forcing migration on upgrade.
- Keep project paths, local source paths, commands, credentials, and context
  content local to the machine.
- Validate the daily-use value through a bounded dogfood trial before expanding
  into more connectors or commerce work.

## 4. User Stories

- As a person working across several repositories, I can map each repository to
  its own profile so agents receive only relevant context.
- As a first-time user, I can keep using the default profile without learning
  profile terminology.
- As an existing user, I can upgrade without losing or rewriting my flat
  manifest until I deliberately create another profile.
- As a desktop user, I can create, rename, inspect, switch, and delete profiles
  without editing JSON.
- As a user, I can add Markdown folders, ContextCake folders, GitHub sources,
  trusted MCP sources, and installed Packs to one profile and control their
  precedence.
- As a cautious user, I can see why a profile was selected and verify it before
  asking project-sensitive questions.
- As a team-sync user, a capture is written only to the live layer belonging to
  the selected profile.
- As a CLI user, I can explicitly select a profile when automatic selection is
  inappropriate.
- As a user with two nested projects, the most specific mapped folder wins.
- As a signed-in user, I can sync safe profile metadata without uploading local
  folder mappings or executable source configuration.

## 5. Acceptance Criteria

### 5.1 Manifest and backward compatibility

- [ ] WHEN a manifest contains top-level `layers[]` and no `profiles` object THE
  SYSTEM SHALL treat those layers as one virtual profile with id `default` and
  SHALL preserve existing resolver, MCP, service, Pack, and team-sync behavior.
- [ ] WHEN a user creates the first additional profile from a legacy manifest
  THE SYSTEM SHALL atomically migrate the existing layers into
  `profiles.default.layers`, preserve their order and every layer field, migrate
  default-stack Pack assignments to profile `default`, and create an atomic,
  timestamped, content-hashed pre-migration backup.
- [ ] WHEN a currently supported transitional manifest contains both top-level
  `layers[]` and synced `profiles` metadata THE SYSTEM SHALL preserve the
  top-level layers as the active legacy stack until an atomic normalization
  moves them into `profiles.default`; inactive synced metadata SHALL NOT be
  opened as runnable sources before normalization.
- [ ] WHEN a canonical v2 manifest is written THE SYSTEM SHALL require a
  `profiles.default` entry and SHALL omit top-level `layers[]`; newly created
  split-brain documents SHALL be rejected while shipped transitional documents
  remain eligible for the defined migration.
- [ ] WHEN a manifest mutation occurs THE SYSTEM SHALL validate the complete
  candidate document before an atomic replacement and SHALL serialize
  concurrent mutations so source, profile, project-mapping, and Pack operations
  cannot overwrite one another.
- [ ] WHEN a profile id is created THE SYSTEM SHALL make it stable and
  URL/CLI-safe; renaming the visible label SHALL NOT change the id or break
  mappings and Pack assignments.
- [ ] WHEN profile metadata arrives from settings sync without its required
  machine-local path, command, credential, or trust confirmation THE SYSTEM
  SHALL store it as an explicitly pending, non-runnable source and SHALL NOT let
  it invalidate or enter any healthy profile's selected layer stack.

### 5.2 Deterministic selection

- [ ] WHEN `contextcake mcp` or another profile-aware CLI command receives
  `--profile <id>` THE SYSTEM SHALL select that profile before inspecting the
  working directory.
- [ ] WHEN there is no explicit profile THE SYSTEM SHALL canonicalize the
  process working directory and select the profile belonging to the longest
  containing project-path mapping, using path-segment containment rather than a
  raw string prefix.
- [ ] WHEN no project mapping matches THE SYSTEM SHALL select the required
  `default` profile.
- [ ] WHEN two mappings could match through aliases or symlinks THE SYSTEM SHALL
  use canonical real paths and reject an equal-specificity conflict rather than
  choosing nondeterministically.
- [ ] WHEN an explicit profile or a matched project mapping names an unknown or
  invalid profile THE SYSTEM SHALL fail closed with an actionable error and
  SHALL NOT fall back to another profile.
- [ ] WHEN a stale mapping points to a folder that no longer exists THE SYSTEM
  SHALL mark it invalid in the app and ignore it for unrelated working
  directories; it SHALL NOT block use of the default profile.
- [ ] WHEN validation finds an invalid structure THE SYSTEM SHALL treat it as a
  fatal manifest error; WHEN it finds an inactive dangling mapping or pending
  source THE SYSTEM SHALL surface a warning; WHEN that dangling reference is
  selected or matched THE SYSTEM SHALL fail closed.
- [ ] WHEN a legacy manifest is used without an override THE SYSTEM SHALL report
  `legacy-default`; WHEN `--profile default` is explicit THE SYSTEM SHALL report
  `explicit`; v2 automatic reasons SHALL be `project` or `default`.

### 5.3 Isolation across every behavior

- [ ] WHEN a profile is selected THE SYSTEM SHALL construct adapters only for
  that profile's layers; sources belonging only to another profile SHALL NOT be
  opened, queried, synced, spawned, or included in output.
- [ ] WHEN MCP read tools run THE SYSTEM SHALL search, list, resolve, and follow
  links only inside the selected profile.
- [ ] WHEN capture or telemetry is enabled THE SYSTEM SHALL discover the live
  layer only inside the selected profile and SHALL reject zero or multiple live
  layers in that profile without inspecting other profiles.
- [ ] WHEN a capture is staged, confirmed, synced, or promoted THE SYSTEM SHALL
  remain bound to the profile selected when the MCP process started; changing
  the Mac app's active profile SHALL NOT redirect a running agent process.
- [ ] WHEN cache or clone storage is shared by multiple profiles THE SYSTEM
  SHALL namespace memory, disk, remote-adapter, and clone state by profile plus
  a canonical source-configuration fingerprint so equal names, renamed sources,
  and the same repository at different refs cannot collide or disclose content.
- [ ] WHEN a profile changes or is deleted THE SYSTEM SHALL leave source files,
  retained Pack versions, local overlays, and live-layer repositories intact
  unless the user separately requests their deletion.
- [ ] WHEN a running agent attempts a capture confirmation or promotion after
  its selected profile or live-layer identity changed or was deleted THE SYSTEM
  SHALL revalidate the binding and reject the write; existing reads MAY continue
  from the process snapshot until that agent is restarted.
- [ ] WHEN promotion is requested in profile-aware mode THE SYSTEM SHALL select
  a manifest profile and target a layer identity within that profile rather than
  accept unrelated source and destination filesystem roots.

### 5.4 Mac app management

- [ ] WHEN the app opens with a configured cascade THE SYSTEM SHALL show the
  active profile label in persistent app chrome without displacing the primary
  navigation.
- [ ] WHEN the user opens the profile switcher THE SYSTEM SHALL list profiles,
  show the current selection, allow keyboard selection, and explain that the
  switch changes the app view but not already-running agent sessions.
- [ ] WHEN the user creates a profile THE SYSTEM SHALL request a label, offer a
  project-folder mapping, and start with either an empty source stack or a
  deliberate copy of an existing profile; the default SHALL be empty.
- [ ] WHEN a copied or synced profile contains an executable MCP source THE
  SYSTEM SHALL keep that source disabled until its exact local configuration is
  confirmed; executable trust SHALL be bound to a local configuration digest
  that changes with profile id, command, or arguments.
- [ ] WHEN the user maps a folder THE SYSTEM SHALL use the native folder picker,
  show nested-mapping precedence, reject duplicate/conflicting canonical paths,
  and keep the absolute path on the local machine.
- [ ] WHEN the user manages a profile THE SYSTEM SHALL let them add, remove,
  inspect, sync, and reorder its layers with the existing trust confirmation for
  executable MCP sources.
- [ ] WHEN layer precedence changes THE SYSTEM SHALL display the resulting
  highest-to-lowest order before saving and SHALL preserve numeric levels in the
  manifest.
- [ ] WHEN a profile has no usable sources THE SYSTEM SHALL show an empty-state
  route to source setup and SHALL NOT present agent connection as ready.
- [ ] WHEN the user attempts to delete `default` THE SYSTEM SHALL refuse; WHEN
  the user deletes another profile THE SYSTEM SHALL show affected project
  mappings and Pack assignments, warn that running agents may retain read access
  until restart, and require confirmation before removing only those references.

### 5.5 Packs and team sync

- [ ] WHEN an installed Pack is attached to a profile THE SYSTEM SHALL add its
  immutable base layer only to that profile and SHALL preserve its local overlay
  and retained versions.
- [ ] WHEN the same Pack is attached to multiple profiles THE SYSTEM SHALL reuse
  the retained immutable files while keeping version assignment and precedence
  explicit per profile.
- [ ] WHEN a Pack is detached or a profile is deleted THE SYSTEM SHALL remove
  only the relevant assignment and layer reference; it SHALL NOT delete Pack
  files still referenced by another profile.
- [ ] WHEN Pack configuration is validated THE SYSTEM SHALL verify the
  bidirectional relationship among registry assignment, profile id, layer name,
  active version, level, layer origin, retained version, and actual profile
  layer before mutation.
- [ ] WHEN a profile contains a team-sync live layer THE SYSTEM SHALL display
  its capture state and sync health within that profile and SHALL enforce the
  existing one-live-layer-per-profile rule.

### 5.6 Agent connection and verification

- [ ] WHEN an MCP process initializes THE SYSTEM SHALL include the selected
  profile id and selection reason in its non-secret usage instructions, return
  the human-readable label only as structured initialization metadata, and
  SHALL NOT change the existing read-tool schemas.
- [ ] WHEN a user runs `contextcake profile current` THE SYSTEM SHALL report the
  selected profile, selection reason, and matched project root if applicable;
  machine-readable JSON SHALL be available.
- [ ] WHEN Connect an Agent renders instructions THE SYSTEM SHALL keep one
  global MCP registration and add a verification step that runs from a mapped
  project and confirms the expected profile before calling `list_concepts`.
- [ ] WHEN an advertised harness does not launch a global MCP server with the
  project as its working directory THE SYSTEM SHALL label automatic mapping as
  unavailable for that client and provide a tested default-profile or explicit
  profile setup instead of implying automatic routing.
- [ ] WHEN an explicit override is needed THE generated guidance SHALL document
  `contextcake mcp --profile <id>` as a separate opt-in registration, not as the
  default setup.

### 5.7 Privacy, security, and account sync

- [ ] WHEN settings sync prepares a payload THE SYSTEM SHALL omit the active app
  profile, project-path
  mappings, matched roots, local source paths, cache paths, executable MCP
  commands/arguments, credentials, and context content.
- [ ] WHEN safe profile metadata syncs THE SYSTEM MAY include stable profile ids,
  labels, presentation preferences, and scrubbed source descriptors, but a new
  Mac SHALL require local folder mapping and executable-source confirmation.
- [ ] WHEN a remote settings snapshot omits, deletes, or incompletely describes
  `default` THE SYSTEM SHALL NOT delete or replace the local runnable default
  stack; it SHALL surface a sync error or pending repair state while preserving
  local use.
- [ ] WHEN profile, source, Pack, or project-mapping input contains prototype
  keys, traversal, malformed encoded values, raw credentials, or unsupported
  fields THE SYSTEM SHALL reject it before persistence.
- [ ] WHEN a profile label is accepted THE SYSTEM SHALL normalize it, enforce a
  bounded display length, and reject control characters and recognized
  credential patterns before it can enter UI, MCP instructions, or sync.
- [ ] WHEN the service mutates profile configuration THE existing loopback,
  bearer-token, Host-header, and same-origin protections SHALL apply.
- [ ] WHEN a profile label or id appears in logs or telemetry THE SYSTEM SHALL
  treat it as local configuration metadata; the locked team telemetry schema
  SHALL NOT be widened for this feature.

### 5.8 Reliability, accessibility, and performance

- [ ] WHEN a profile switch occurs in the app THE SYSTEM SHALL cancel or ignore
  stale responses from the prior profile so its concepts cannot flash or remain
  in the new view.
- [ ] WHEN the service returns any profile-derived read or mutation response THE
  SYSTEM SHALL include an immutable profile id plus manifest revision; the
  renderer SHALL commit a multi-request load only when every response matches
  the expected pair, and mutations SHALL require an explicit profile id and
  revision precondition.
- [ ] WHEN source initialization for one profile fails THE SYSTEM SHALL surface
  the affected source and continue with the other layers under the existing
  warn-and-continue policy; a malformed profile contract SHALL fail before any
  source is opened.
- [ ] WHEN 25 profiles and 100 project mappings are configured THE SYSTEM SHALL
  select a profile without network access and without a user-perceptible delay.
- [ ] WHEN the profile UI is used at supported desktop and narrow widths THE
  SYSTEM SHALL remain keyboard operable, keep focus visible, avoid page-level
  horizontal scrolling, and meet the project's WCAG AA target.

### 5.9 Dogfood success gate

- [ ] WHEN implementation is feature-complete THE team SHALL run a seven-day
  trial with at least 30 recorded starts using at least three materially
  different profiles and at least two AI harnesses, including at least five
  starts per profile and ten per harness; failed starts SHALL remain in the
  denominator.
- [ ] WHEN a session starts inside a mapped project THE selected profile SHALL
  be correct in 100% of recorded trial starts, with zero cross-profile reads,
  cache hits, captures, or Pack assignments.
- [ ] WHEN the trial ends at least 90% of mapped-project sessions SHALL require
  no manual profile override, and the user SHALL be able to identify the active
  app profile and agent-selected profile in under ten seconds.
- [ ] WHEN trial friction is recorded THE next connector SHALL be chosen from
  repeated missing-source evidence; Slack, Confluence, Google Drive, billing,
  and marketplace work SHALL remain deferred until this gate passes.

## 6. Out of Scope

- Automatic source discovery or content ingestion from the entire filesystem.
- Switching the profile of an already-running MCP process.
- Combining multiple profiles in one answer or allowing cross-profile search.
- Remote storage of project mappings, local paths, context content, or
  integration credentials.
- A hosted ContextCake MCP service.
- Slack, Confluence, or Google Drive adapters.
- New resolution rules, semantic retrieval, embeddings, or autonomous conflict
  reconciliation.
- Turning on billing, checkout, creator submissions, or marketplace claims.
- Deleting source directories, repositories, caches outside ContextCake's own
  cache root, local overlays, or retained Pack content as a side effect of
  profile deletion.
- Windows/Linux desktop UX in this release; core selection behavior remains
  path-platform-aware and testable outside macOS.

## 7. Open Questions and Resolved Defaults

There are no blocking product questions in this draft. The following defaults
are explicit so implementation does not silently invent them:

| Question | Default |
|---|---|
| User-facing term | **Project profile**; shortened to **Profile** in compact UI |
| Required fallback id | `default` |
| New profile contents | Empty; copying another profile is a deliberate action |
| Automatic routing signal | Longest canonical containing project folder |
| Manual app selection | Affects the app only, not running MCP processes |
| CLI override | `--profile <id>` wins over working-directory mapping |
| Profile deletion | References only; never underlying user content |
| Project-path sync | Never synced |
| Active app profile sync | Never synced; remote activity is not an activation signal |
| Source sharing | Each profile owns layer configuration; retained Pack files may be shared |
| Ambiguous/invalid matched mapping | Fail closed rather than fall through |
| Legacy migration trigger | First creation of an additional profile |
| Transitional hybrid manifests | Preserve current flat behavior until atomic normalization |
| Synced incomplete source metadata | Pending and non-runnable until local repair/trust |

Changing a default that affects resolution, privacy, capture routing, or
deletion safety requires a spec amendment.

## 8. Dependencies

- The existing flat-manifest resolver, MCP, and engine-service paths.
- The approved Manifest v2 profile shape and selection order in
  `specs/contextcake-integrations/spec.md`.
- The Mac app's native folder picker, settings storage, bearer-protected engine
  service, and optional safe settings sync.
- The existing Pack registry and profile-aware CLI assignment fields.
- The team-sync live-layer and capture contracts, extended from one flat stack
  to one selected profile.
- The GitHub source adapter work must be merged and its credential-injection
  boundary retained before private GitHub repositories are offered in profile
  setup. Project Profiles themselves remain usable with local Markdown and
  ContextCake folders if that dependency ships later.

## 9. Requirement Traceability

This spec narrows and completes existing contracts rather than introducing a
new architecture:

- Integrations §5 supplies explicit → longest-prefix → default selection,
  backward compatibility, and local credential custody.
- Distribution design §5 supplies the local manifest and settings locations;
  the active app profile is a preference, while mappings remain in the local
  manifest.
- Harness Connect supplies the single global MCP registration and verification
  surface.
- Packs supplies immutable installed versions, local overlays, and per-profile
  assignments.
- Team Sync supplies the one-live-layer rule, capture safety, and content-free
  telemetry; this feature scopes all of them to the selected profile.
