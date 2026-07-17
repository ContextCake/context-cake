# ContextCake Team Sync — Spec

Shared working memory for AI-assisted teams: when one person's agent resolves an
investigation, every teammate's agent can find it within minutes — without
bypassing the review gate that protects curated team knowledge.

**Date:** 2026-07-16
**Status:** Approved (decisions locked with John, 2026-07-16)
**Workflow:** Requirements-First, constrained by the two-rules-plus-escape-hatch
ceiling (`specs/contextcake-core/design.md` §9) — team sync adds a namespace and
a write path, never a resolution rule
**Depends on:** `specs/contextcake-core/design.md` (resolution, boundaries),
`specs/contextcake-integrations/spec.md` (cache/`sync()`, profiles, credential
custody), `specs/contextcake-harness-connect/spec.md` (onboarding, first-use
prompt), `specs/contextcake-packs/` (plugin distribution)

---

## 1. Problem statement

ContextCake today is shared **long-term memory**: curated, reviewed, git-paced.
Teams using AI harnesses (Claude Code, Copilot, Cursor) also need shared
**working memory**: a teammate's agent investigated an issue half an hour ago,
found the root cause, and wrote a spec — my agent, starting the same
investigation now, should know that. Today that knowledge lives in one person's
session transcript and evaporates.

The existing capture pipeline (`classify-context` → `ingest` → `write` →
review queue → `promote`) is fed by repo events, not agent sessions, and the
cascade's curated layers are the wrong destination for high-churn, unreviewed
findings. What's missing is a **fast lane with different physics** — high
churn, lower trust, short half-life — that feeds the curated cascade through
the existing review gate instead of around it.

## 2. Goals

- **Session capture:** an agent session that ends in a resolution produces a
  structured capture (problem signature, attempts, findings, fix/spec link,
  confidence) with near-zero user effort.
- **Live layer:** captures land in a team-shared `investigations/` namespace,
  clearly labeled unreviewed, decaying unless promoted.
- **Cross-tool:** any MCP-capable harness can read *and* capture through the
  same single endpoint (capture is explicitly opt-in).
- **Propagation:** a capture is visible to teammates' agents within ~2 minutes,
  with no new infrastructure and no content passing through any
  ContextCake-operated server.
- **Telemetry:** the team can see adoption and reuse (the north-star metric:
  **cross-brain hits** — reads of a concept captured by a *different* person)
  without anyone's prompts or session content being recorded.

## 3. User stories

- As an engineer, when my agent starts investigating a bug, it checks recent
  team investigations and surfaces a teammate's matching capture with author,
  age, and review status.
- As an engineer, when my session ends with a fix or spec, my harness offers a
  structured capture to the team's live layer so I don't write it up manually.
- As a Copilot/Cursor user, I capture and read through the same ContextCake MCP
  endpoint my Claude Code teammates use.
- As a reviewer, I promote a good capture into the curated team layer through
  the existing review queue — the live layer never silently becomes doctrine.
- As a team lead, I see capture volume, cross-brain hits, and time-to-reuse on
  the control surface, without access to anyone's session content.
- As a cautious engineer, capture is off until I turn it on, and I can see
  what will be shared before it leaves my machine.

## 4. Acceptance criteria (EARS)

### Live layer & namespace
- [ ] WHEN a profile declares a live layer THE SYSTEM SHALL scope its concepts
  to a distinct `investigations/` namespace and SHALL NOT merge them into
  curated concepts by precedence (cross-references via `get_links` only — no
  new resolution rule).
- [ ] WHEN the MCP server renders a live capture THE SYSTEM SHALL label it as
  an unreviewed capture with author and timestamp, using the same visual
  treatment discipline as conflict rendering.
- [ ] WHEN a capture exceeds 14 days without promotion THE SYSTEM SHALL archive
  it out of default resolution and retrieval results (retention is
  team-configurable; 14 days is the default).
- [ ] WHEN a capture is promoted THE SYSTEM SHALL route it through the existing
  review queue into the target curated layer (extension of the `promote` path,
  live → team).

### Capture
- [ ] WHEN capture is not explicitly enabled THE SYSTEM SHALL write no
  session-derived content anywhere (default off, per user per machine).
- [ ] WHEN a Claude Code session ends with a resolution event THE capture hook
  SHALL produce a structured capture and submit it through the classifier;
  non-resolution sessions SHALL produce nothing (noise gate #1).
- [ ] WHEN a capture is submitted THE classifier SHALL route it
  (ignore / local / team-live / review_required) before anything reaches the
  shared layer (noise gate #2).
- [ ] WHEN a capture body matches credential patterns THE SYSTEM SHALL fail the
  write (same check the integrations spec applies to manifests — sessions see
  secrets; captures must not carry them).
- [ ] WHEN the MCP server is started with the capture flag THE SYSTEM SHALL
  expose a `log_investigation` write tool that accepts a capture through the
  identical validation path; WHEN started without the flag THE SYSTEM SHALL
  expose only the existing read-only tools (the harness-connect read-only
  promise holds by default).
- [ ] WHEN a capture is written THE SYSTEM SHALL attribute it to the
  live-layer repo's git identity when one is configured; WHEN none is
  configured THE SYSTEM SHALL prompt once for a profile name at capture
  enablement and use it thereafter.
- [ ] WHEN a capture is about to be shared THE SYSTEM SHALL show the rendered
  capture and require confirmation before it leaves the machine
  (show-before-share is the default; a team may opt into silent capture, whose
  visibility then comes from the activity feed).

### Sync & resilience
- [ ] WHEN a capture lands in a live layer backed by a shared git remote THE
  SYSTEM SHALL push it promptly, and readers with default cache settings SHALL
  observe it within 2 minutes (short-TTL cache; no push infrastructure).
- [ ] WHEN the remote is unreachable THE SYSTEM SHALL queue the capture
  locally, warn-and-continue (core design §8 posture), and sync on recovery.
- [ ] WHEN any team-sync feature operates THE SYSTEM SHALL move no capture or
  telemetry content through a ContextCake-operated server (inherits the
  integrations 🚫 boundary; a notification-only relay is a future spec).

### Retrieval
- [ ] WHEN an agent calls `find_investigations` with a query THE SYSTEM SHALL
  return matching captures ranked by recency and relevance, each with author,
  age, and review status.
- [ ] WHEN an agent calls `whats_new` with a timestamp THE SYSTEM SHALL return
  captures and curated-concept changes since that time.
- [ ] WHEN harness-connect generates client guidance or the pack skill installs
  THE guidance SHALL instruct agents to call `find_investigations` before
  starting an investigation and `log_investigation` (where enabled) after
  resolving one.

### Telemetry
- [ ] WHEN telemetry is enabled THE SYSTEM SHALL record concept-level events
  only (concept id, layer, event kind, harness kind, user, timestamp) and
  SHALL never record prompts, transcripts, or capture bodies.
- [ ] WHEN the control surface renders team metrics THE SYSTEM SHALL show
  cross-brain hits, capture volume, time-to-first-reuse, and review-queue
  throughput, plus an activity feed of recent captures.
- [ ] WHEN telemetry is disabled THE SYSTEM SHALL remain fully functional
  (metrics are additive, never load-bearing).
- [ ] WHEN telemetry events are aggregated for the team THE SYSTEM SHALL store
  them as an append-only event log inside the live-layer repo — same trust
  boundary as the captures themselves, read by the control surface like any
  other content, no new infrastructure.

## 5. Out of scope (v1)

Notification relay / push (SSE or webhooks — future spec; ⚠️ per integrations
boundary) · CRDT or any real-time co-editing (captures are append-only
documents) · automatic capture from harnesses without session hooks (manual
`contextcake capture` + `log_investigation` is the v1 path there) · semantic
signature rendezvous (v1 keys captures by agent-generated slug + search;
normalized error-signature keys are a later increment) · hosted ContextCake
service or cross-team federation · mining session history retroactively.

## 6. Open questions

None for this release. Resolved with John, 2026-07-16: retention defaults to
14 days; attribution is git identity with a one-time profile-name prompt as
fallback; show-before-share is the default sharing behavior; telemetry
aggregates live as an append-only log inside the live-layer repo.

## 7. Dependencies

- Cache layer with `sync()` + TTL, profiles, credential-pattern check
  (`specs/contextcake-integrations/spec.md`).
- Onboarding + first-use prompt surface to carry the new guidance
  (`specs/contextcake-harness-connect/spec.md`).
- Existing pipeline: `classify-context.mjs`, `write.mjs`, `promote.mjs`,
  control-surface review queue.
- Packs as the distribution vehicle for the capture plugin (hook + skills).

## 8. For the implementing agent

- **Commands:** `npm test` from repo root; `node packages/core/src/mcp-server.mjs
  --manifest layers.json` (add the capture flag here); control surface via
  `python3 -m http.server 8788 --directory apps/control-surface`.
- **Testing:** bash suites under `packages/core/tests/` following the
  `source-test.sh` idiom (temp dirs, `trap` cleanup, no network) — a local
  bare git repo on disk stands in for the shared remote; capture, decay,
  promotion, and credential-rejection each get assertions.
- **Project structure:** capture/validation logic in `packages/core/src/`
  beside `classify-context.mjs`; the live layer is an existing source kind
  (`okf-local`/`files`) over a git-backed directory — no new adapter; MCP tools
  in `mcp-server.mjs`; feed + metrics panels in `apps/control-surface/`; the
  Claude Code plugin (hook + skills) lives with Packs, not in `packages/core`.
- **Code style:** ESM `.mjs`, Node ≥ 18 built-ins only, sparse comments, match
  the voice of `resolver.mjs` / `okf-local.mjs`.
- **Git:** conventional commits; one PR per coherent slice (capture path, MCP
  tools, control surface, plugin pack).
- **Boundaries:**
  - ✅ **Always:** engine stays dependency-free; OKF is the output format;
    warn-and-continue on sync failure; capture default-off; unreviewed
    provenance rendered on every live capture.
  - ⚠️ **Ask first:** any relay/push machinery; any new resolution rule (the
    two-rules ceiling holds — investigations are namespaced *because* of it);
    widening telemetry fields; new capture namespaces beyond `investigations/`.
  - 🚫 **Never:** commit secrets — captures matching credential patterns are
    rejected, not redacted-and-shared; prompts/transcripts/capture bodies in
    telemetry; capture or telemetry content through ContextCake-operated
    servers; MCP write access to curated layers; npm dependencies in
    `packages/core`.
- **Self-verification:** compare the implementation against §4 and list any
  criteria not addressed.
