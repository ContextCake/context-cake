# ContextCake Project Profiles — Adversarial Review Record

**Date:** 2026-07-28
**Artifacts reviewed:** `spec.md`, `design.md`
**Method:** independent read-only critic plus primary-agent red-team pass
**Review posture:** poke holes first; prioritize isolation, migration, privacy,
write safety, backward compatibility, and testability
**Outcome:** all seven blocking findings were accepted and incorporated into the
planning artifacts; implementation evidence does not exist yet

---

## 1. Blocking Findings and Resolutions

### B1. Synced incomplete profiles could invalidate healthy local use

**Finding:** Account sync currently reconstructs profile layers after scrubbing
machine-local paths and commands. The draft simultaneously allowed these
incomplete shells and required whole-manifest validation before any source
opened.

**Impact:** Pulling settings on a new Mac could make the complete manifest
unusable, including a healthy local default profile.

**Resolution:** Accepted. Canonical profiles now have explicit
`pendingSources[]`. Incomplete or untrusted synced descriptors are structurally
valid repair tasks but are never passed to adapters, selection, MCP, sync, or
live-layer discovery. Migration and tests cover a healthy local profile beside
an incomplete remote shell.

### B2. Synced `activeProfile` could remotely activate local executable sources

**Finding:** `activeProfile` is currently syncable. Merge-by-source identity can
preserve a local MCP command underneath remotely scrubbed metadata.

**Impact:** A remote snapshot, account switch, or id collision could select a
local profile and spawn its MCP command without fresh local intent.

**Resolution:** Accepted. The active app profile is now local-only. Executable
source trust is a non-synced, machine-local digest bound to profile id, source
identity, command, arguments, and optional account owner. Copies, remote shells,
config changes, and account changes require confirmation again.

### B3. Shipped hybrid manifests had no upgrade path

**Finding:** The first draft rejected any document with both top-level `layers`
and `profiles`, but current Pack/settings-sync behavior can already produce and
test that transitional shape.

**Impact:** A supported current configuration could fail on upgrade and strand
Pack assignments, pending sources, or synced metadata.

**Resolution:** Accepted. The selector recognizes a transitional hybrid mode and
continues current flat-stack behavior until deliberate normalization. The atomic
migration preserves named profiles, owner metadata, pending sources, runnable
local fields, and Pack assignments. Real current-version manifests join the
upgrade fixture corpus.

### B4. Profile/revision identity covered only part of the Console load

**Finding:** The Console loads graph and resolved concepts through separate
requests. Adding profile identity only to `/api/graph` still permits mixed
generations, and mutations targeting the merely “active” profile can race a
switch.

**Impact:** The UI could display topology from one profile with content from
another or mutate the wrong stack.

**Resolution:** Accepted. Every profile-derived response carries
`{profileId, manifestRevision}`. Multi-request loads commit only when every
response matches the expected pair. Every profile/source/Pack/mapping mutation
names a profile and supplies a revision precondition; stale operations return
409.

### B5. Cache isolation omitted configuration identity and clone state

**Finding:** Profile plus source name is insufficient. Current cache paths use
source names, and clone-backed GitHub storage uses a repository slug without ref
or profile identity.

**Impact:** Renamed/reconfigured sources or the same repository at different
refs could share stale or wrong content across profiles.

**Resolution:** Accepted. The plan now hashes profile id plus the canonical
source configuration—kind, root/endpoint/repository, ref, path selection, and
adapter options—into every memory, disk, remote API, and clone namespace. Tests
cover same-name/different-source and same-repo/different-ref cases.

### B6. A one-time fixed backup could become stale or corrupt

**Finding:** Creating one never-overwritten migration backup allows a failed
first attempt to leave an old or partial file that later appears authoritative.

**Impact:** Manual recovery could discard newer configuration.

**Resolution:** Accepted. Backups are atomic, timestamped, and named/recorded
with the source manifest SHA-256. Recovery verifies the content hash and warns
that changes after the timestamp will be lost. No backup is restored
automatically.

### B7. Promotion remained path-based and outside profile isolation

**Finding:** The draft required selected-profile promotion, but the current CLI
accepts arbitrary source and target roots without reading a manifest.

**Impact:** The requirement was unenforceable; a caller could promote between
unrelated profile roots.

**Resolution:** Accepted. The plan adds a profile-aware promotion entry point
that resolves live and target layers by identity from one selected manifest and
revalidates before writing. Raw-path promotion remains an explicitly separate
legacy/advanced mode without a profile-isolation claim.

## 2. Non-Blocking Findings and Resolutions

| Finding | Disposition |
|---|---|
| Legacy `--profile default` reason contradicted the test matrix | Fixed: explicit override reports `explicit`; no override reports `legacy-default`. |
| Dangling-reference validation classes were ambiguous | Fixed: fatal structure, inactive warning, and selected-fatal classes are explicit. |
| Pack registry/layer invariants were incomplete | Fixed: bidirectional assignment/layer/version/origin/level validation and fixtures added. |
| Automatic CWD routing lacked a five-client proof matrix | Fixed: every advertised client must be tested; unsupported clients are labeled Default/explicit rather than automatic. |
| Profile labels lacked bounds and hostile-input handling | Fixed: NFC, trimming, 1–80 character bound, control/line-break and credential-pattern rejection. |

## 3. Suggestions Applied

- Added a sanitized real-world upgrade corpus from current Pack, team-sync,
  signed-in sync, pending-source, and older desktop manifests.
- Made dogfood reproducible: at least 30 starts, five per profile, ten per
  harness, failed starts retained, timestamped local scoring.
- Added deletion language explaining that running agents can retain snapshot
  read access until restart; capture/promotion writes revalidate and fail after
  profile deletion or live-layer change.

## 4. Additional Primary-Agent Amendments

The primary red-team pass also tightened two areas adjacent to the independent
findings:

- Equal-level sources remain explicit tie groups so visual reordering does not
  silently erase the existing recency tie-break rule.
- Pending synced sources and executable trust are separated: source metadata can
  sync, but runnable commands and local activation cannot.

## 5. Rejected Findings

None. Every material finding was within the requested feature scope and improved
the safety or testability of the plan.

## 6. Review Exit Criteria

The planning review is closed because:

- every blocking finding has a concrete requirement, design response, test, or
  rollout gate;
- no unresolved marker or blocking product question remains;
- the plan preserves the approved integration, auth, Packs, distribution, and
  team-sync boundaries;
- remaining risk is implementation risk, to be handled by per-PR review and the
  seven-day dogfood gate rather than hidden in the planning document.
