# ContextCake Team Sync — Design

How the approved spec (`spec.md`) gets built: a capture taxonomy over one live
namespace, in-session two-phase capture, git-backed sync below the MCP
boundary, and content-free telemetry aggregated from per-author logs.

**Date:** 2026-07-16
**Status:** Approved (design review with John, 2026-07-16)
**Spec:** `specs/contextcake-team-sync/spec.md`
**Design revisions from review:** capture generalized beyond investigations to
a kind taxonomy; sync designed harness-agnostic by construction (below the MCP
boundary), with explicit concurrency handling.

---

## 1. Capture taxonomy & schema

One live namespace, `captures/<kind>/<slug>`. Kinds in v1:

| Kind | Shape | Promotes into |
|---|---|---|
| `investigation` | problem → attempts → root cause → fix | team knowledge concept |
| `decision` | chose X over Y, alternatives, why | curated `decisions/<slug>` |
| `gotcha` | one fact that will bite the next person | section of a related concept |
| `artifact` | summary + pointer (spec/plan/PR a session produced) | link from related concepts |

A capture is a single OKF file. Frontmatter: `kind`, `author`, `captured`
(ISO date), `confidence`, `status: unreviewed`, `links[]` (related concept
ids, issue keys, PRs). Sections are kind-appropriate (an investigation carries
`problem` / `attempts` / `root-cause` / `fix`; a gotcha is mostly `body`).

Decay is uniform: every unpromoted capture leaves default resolution and
retrieval at 14 days, regardless of kind. Durability comes only from
promotion — an unreviewed decision rotting at 14 days is the review incentive
working, not a bug. Promotion is two-step through `_review/promotions/` in the
curated bundle (request stages a review entry with a per-kind default
destination; approve writes the curated concept, verifies the write is
durable, and only then removes the review entry and the live capture). The
control surface lists pending promotion requests with their destinations.

## 2. Capture mechanism — in-session, two-phase

**In-session distillation** (chosen over post-hoc headless): the pack skill
instructs the agent to log a capture at the resolution/decision moment; a Stop
hook nudges when a session looks capture-worthy but nothing was logged. No
second model run, full session context available, and the user is present —
which show-before-share requires. Post-hoc transcript sweeps are explicitly
not built in v1.

**Two-phase MCP write** makes show-before-share harness-agnostic:

1. `log_capture(payload)` — validates schema, runs the classifier
   (ignore / local / team-live / review_required), runs the credential-pattern
   scan (match → hard reject, never redact-and-share), stages the capture, and
   returns the rendered preview plus a staging token for the agent to display.
2. `confirm_capture(token)` — called only after the human confirms in chat;
   commits to the live repo and pushes.

This works identically in Claude Code, Cursor, and Copilot chat — no
harness-specific UI. The desktop app additionally lists staged captures.
Staging tokens are in-memory per server process, expire after 10 minutes, and
are single-use (consumed on confirm, including failed confirms). Both tools exist only when the server runs with the capture flag;
without it the server is byte-for-byte the read-only surface harness-connect
promised.

**Pack contents:** Claude Code plugin (skill + Stop hook), a `.cursor/rules`
snippet, and an `AGENTS.md`/copilot-instructions snippet — all teaching the
same two calls plus `find_captures`-before-investigating.

## 3. Live layer & decay

The live layer is a plain okf-local bundle over a git repo — no new adapter
kind. File paths are per-author: `captures/<kind>/<author>--<slug>.md`, so
concurrent captures never produce content-level merge conflicts and rebases
are trivially clean.

Decay is a **read-time filter**: `captured` older than the retention window
(default 14 days, per-layer configurable) excludes the concept from default
`listConceptIds`, resolution, and `find_captures`; direct reads by id still
work, and an include-archived flag exists for the control surface. No cron,
no file moves, append-only git history.

Attribution: the live-layer repo's git identity when configured; otherwise a
one-time profile-name prompt at capture enablement (spec §4).

## 4. Sync — below the MCP boundary

Sync lives in the source layer, not in any harness integration, so every
client of `contextcake mcp` (Claude Code, Cursor, Copilot, CLI, headless) gets
identical freshness.

**Shape:** `withGitSync(source, opts)` — a wrapper source composing with the
existing `withCache` pattern (gitSync wraps outermost so reads reach the pull
gate even when a cache is configured), enabled by a manifest `git` block on
the layer (e.g. `"git": { "pullTtlSeconds": 90, "retentionDays": 14 }` plus
`"live": true` marking the single writable live layer). v1 targets the flat
`layers[]` manifest; the single-live-layer rule carries forward per-profile
when the integrations profiles work lands.

- **Pull:** TTL-gated (default 90s) `git pull --ff-only --quiet` before reads.
  Multiple harness processes run engines over the same working tree
  concurrently, so every git mutation is guarded by an advisory `.contextcake.lock`
  (pid + timestamp, JSON, inside the repo root; stale after 120s, stolen
  atomically via rename); on contention a reader skips the pull and serves the
  current tree — staleness stays bounded by the TTL. All of this lives in
  `git-core.mjs`, which `git-sync.mjs` (the `withGitSync` wrapper) and the
  capture/promote paths call — nothing runs git against a live root directly.
- **Push:** `confirm_capture` commits and pushes. On failure: retry as
  `git pull --rebase` then push; still failing → the capture remains committed
  locally, flagged queued, and is retried on the next capture or explicit
  Sync. A capture is never lost and never blocks the session.
- **Divergence:** per-author files (captures and telemetry both) keep rebases
  conflict-free in practice; ff-only pull with rebase fallback covers the
  rest. A rebase that does conflict (should require manual file collision)
  surfaces as a warning and leaves the queue intact.
- **Auth:** ambient git credentials (ssh agent / credential helper).
  ContextCake never handles a token; team membership = repo access. This is
  the credential-custody philosophy applied by delegation.
- **Engine purity:** spawns the `git` CLI via `child_process` — no npm
  dependency; same precedent as the `mcp` source spawning foreign servers.
  `git` absent → warn-and-continue as a plain local layer.

The 2-minute propagation target (spec §4) falls out: push-on-confirm plus a
90s pull TTL.

## 5. Retrieval

- `find_captures(query, kinds?)` — scoring reuses mcp-server's internal
  tokenize/scoreText (keyword match over title/sections/links) multiplied by
  exponential recency decay with a true 7-day half-life (`2^(-ageDays/7)`,
  ≈ retention/2); returns author, age, kind, review status per hit. No embeddings — dependency-free, and the corpus is small by design
  (14-day window).
- `whats_new(since)` — captures plus curated-concept changes since the
  timestamp, for session-start orientation.
- Rendezvous v1 is slug + search (spec: out of scope for signature keys).

## 6. Telemetry

The MCP server is the chokepoint: when telemetry is enabled it records
`{ts, user, harness, event, concept, layer, captureKind}` for `read`,
`search_hit`, `capture`, `confirm`, and `promote` — never prompts,
transcripts, or capture bodies.

Events append to per-author monthly NDJSON:
`telemetry/<author>/<YYYY-MM>.ndjson` in the live-layer repo — append-only per
author, so no merge conflicts, same trust boundary as captures. Each event
appends synchronously to the local file (O_APPEND line writes — crash-safe,
concurrency-safe at line granularity); the **git** cadence stays lazy —
telemetry rides along in confirm/promote commits and explicit sync, never a
commit-per-read.

Control surface aggregates across author files: **cross-brain hits** (reads of
a concept captured by a different person), capture volume, time-to-first-reuse,
review-queue throughput, plus an activity feed ("<author> captured
`captures/investigation/...` 32 min ago"). Telemetry disabled → everything
else fully functional (spec §4).

## 7. Component map

| Piece | Where | What |
|---|---|---|
| `capture.mjs` | `packages/core/src/` | schema validation, classifier hookup, credential scan, staging, two-phase confirm, commit+push |
| `git-core.mjs` | `packages/core/src/sources/` | locked git mutation coordinator: advisory lock, pathspec commit, push-with-rebase-retry + offline queue, URL-scrubbed errors |
| `git-sync.mjs` | `packages/core/src/sources/` | `withGitSync` wrapper (TTL pull, decay filter, sync) + `resolveLiveLayer` manifest contract |
| MCP tools | `mcp-server.mjs` | `find_captures`, `whats_new`; `log_capture` + `confirm_capture` behind capture flag; read-event telemetry |
| Decay filter | resolver/okf-local read path | retention window on `captured` frontmatter |
| Promotion | `promote.mjs` + control surface | live → curated per-kind targets, two-step via `_review/promotions/` |
| Feed + metrics | `apps/control-surface/` | activity feed, cross-brain hits, reuse metrics |
| Capture pack | `examples/team-sync-pack/` | Claude Code plugin (skill + Stop hook), Cursor rules, Copilot/AGENTS.md snippet; Packs may rebundle later |

## 8. Error handling

Warn-and-continue everywhere, matching core §8 posture: pull failure serves
stale with cache age; push failure queues silently-visibly (warning + control
surface flag); schema-invalid captures return the reason to the agent for
repair; credential match is a hard reject with no partial write; missing
`git` or unreachable remote degrades the live layer to local-only. Capture
paths never block session end and never throw past the MCP boundary.

## 9. Testing

Bash suites under `packages/core/tests/`, `source-test.sh` idiom (temp dirs,
`trap` cleanup, no network); an on-disk bare repo is the fixture remote.

- `capture-test.sh` — schema validation, classifier routing, credential
  rejection, two-phase stage/confirm, stale-token rejection.
- `git-sync-test.sh` — TTL-gated pull, lock contention (two concurrent
  readers), push retry after simulated divergence, offline queue and
  recovery.
- Decay: capture aged past retention disappears from list/search, remains
  readable by id.
- Retrieval: `find_captures` ranking (keyword × recency), kind filtering.
- Telemetry: events append per-author, aggregation math on a fixture log,
  no-content invariant asserted.

## 10. Spec traceability

Every §4 criterion in the spec maps to a design section: live layer &
namespace → §1/§3; capture criteria → §2 (two-phase = show-before-share);
sync & resilience → §4; retrieval → §5; telemetry → §6. Spec amendments made
alongside this design: `investigations/` generalized to `captures/` + kind
taxonomy; `log_investigation`/`find_investigations` renamed to
`log_capture`/`find_captures`; two-phase confirm named as the
show-before-share mechanism.

## 11. Open items — all resolved in planning (2026-07-16)

- ~~Slice order~~ → PR boundaries in the implementation plan: engine
  (git-core, git-sync, capture) → MCP + telemetry + promotion → surfaces
  (control surface, pack, docs).
- ~~Classifier rules~~ → a dedicated `fixtures/capture-policy.json` (kinds as
  team-candidate labels; review keywords carried over; ignore keywords for
  scratch work) rather than widening `context-policy.json`.
- ~~Staging tokens~~ → in-memory per server process, 10-minute TTL,
  single-use (§2).
- ~~Control-surface aggregation~~ → a generator script reads the live root
  directly from disk plus telemetry NDJSON and emits a static JSON the panel
  renders (signals.json pattern). Reading raw disk also gives the control
  surface access to archived (decayed) captures, which the read-time filter
  hides from agents.
