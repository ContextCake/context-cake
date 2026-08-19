---
title: Discrepancy API
description: Structural detection, transactional decisions (single and batch), broken-link fixes, and governed local or team rules.
---

The engine service exposes the Discrepancy Center through additive JSON APIs.
The original resolver output and `/api/conflict-resolutions` endpoint remain
available for compatibility. Every route below is behind the service's bearer
token; every writing route is behind its mutation gate (405 when disabled).

## Detection

`GET /api/discrepancies` returns structural `section_content`,
`frontmatter_value`, `broken_link`, and `changed_after_decision` records. Every
record includes a stable ID, current revision, deterministic winner reason,
all values and fingerprints, source health, owner, priority, status, history,
and matching rules. `coverageComplete: false` means broken-link detection has
been paused because at least one required source is still indexing or unhealthy.

Broken-link records also carry structural repair `candidates` (relative path,
case, extension, slug, moved basename, title, bounded edit distance — never
model-inferred) and a `bestCandidate` when one candidate is confident and
unambiguous. Candidates are not part of the record's `revision`.

Every read answers from one memoized projection, so the shapes below agree
with each other for the same `projectionRevision`:

- `GET /api/discrepancies?fields=compact&status=&kind=&conceptId=&target=&source=&owner=&conceptType=&limit=&offset=`
  — the list with bodies previewed (240 chars, `truncated`/`valueBytes`/
  `valueKind`), history folded into `historyCount` + `latestDecision`, plus
  `summary`, `total`, `filtered`, `offset`, `limit`, `projectionRevision`.
  `status=actionable` selects every status a person still has something to do
  about. `limit` is capped at 5000.
- `GET /api/discrepancies?id=<id>` — one full record (`{ discrepancy | null }`).
- `GET /api/discrepancies/summary` — counts by kind and status, groupings by
  source pair / owner / concept type, `topTargets` (broken links per missing
  target, with the shared `bestCandidate` when every open record agrees),
  `topConcepts`, and `quickWins`.

`PATCH /api/discrepancies?id=…` accepts `{ "priority": "high" }`; allowed
values are `unassigned`, `high`, `medium`, and `low`. Priority is explicitly
assigned by a user and does not affect resolver precedence.

## Decisions

`POST /api/discrepancy-decisions` requires `discrepancyId`, the displayed
`revision`, and one action:

- `choose_contribution` with `selectedSource`
- `compose` with Markdown `content`
- `acknowledge` with `reasonCode` and an optional local `note`
- `rewrite_link` with `newTarget` (broken links only) — points the link at an
  existing concept
- `unlink` (broken links only) — turns the link back into text (its label,
  alias, or basename)
- `create_stub` with `layer` and optional `title`/`type` (broken links only) —
  creates the missing concept as a minimal document in a writable layer

Acknowledgement reason codes are `different_scopes`, `temporary_migration`,
`source_specific_authority`, `target_missing`, and `other`. `target_missing`
is the console's dedicated reason for `broken_link` discrepancies.
Acknowledgement writes no source content.

`rewrite_link` and `unlink` edit exactly the effective contributor's section
(the one contribution a broken-link record has), read live from disk so
consecutive edits to one section compose. `create_stub` writes a new file
through the same staged transaction, exclusively — a path that already exists,
or one the filesystem folds onto differently-cased folders, is refused. Choose
and compose are refused on a broken link (409 `BROKEN_LINK_NOT_WRITABLE`); the
link actions are refused on every other kind (400 `ACTION_INVALID`).

Write actions preflight every writable target, journal a prepared transaction,
keep recoverable originals beside each file, and either commit the complete
set or report rollback/recovery state precisely. A contributor inside the live
team layer is committed through the locked git path as one pathspec commit per
decision and pushed after the decision is durable and the lock is released;
an unreachable remote is `{ pushed: false, queued: true }`, never a failure.

The response is `{ ok, decision, written: [layer], git? }` where `git` is
`{ layer, paths, committed, pushed, queued }` when the live layer was touched.
Errors are `{ error, code?, … }`; `code` is the stable machine code
(`NOT_OPEN`, `STALE`, `COVERAGE_INCOMPLETE`, `SOURCE_NOT_WRITABLE`,
`LINK_TARGET_MISSING`, `LINK_GONE`, `TARGET_EXISTS`, `TARGET_CASE_CONFLICT`,
`LIVE_LAYER_BUSY`, `ROLLED_BACK`, `RECOVERY_REQUIRED`, …).

Records append as schema v2 to
`.contextcake/profiles/<profile-id>/conflict-resolutions.ndjson` (the default
profile uses `profiles/default/`; pre-profile files migrate there on first
access). Existing schema-v1 records are read unchanged. Transaction states
append to `.contextcake/profiles/<profile-id>/discrepancy-transactions.ndjson`.
A rewrite records `newTarget`; a stub records `createdTargets`; both keep the
`linkTarget` and `sectionKey` they acted on.

## Batch decisions

`POST /api/discrepancy-decisions/batch` takes
`{ decisions: [ …single decision bodies… ], stopOnError?, dryRun? }` — at most
500 decisions (413 `BATCH_TOO_LARGE`), at least one (400 `DECISIONS_REQUIRED`).

The batch takes one manifest lock and one settled projection (409
`COVERAGE_INCOMPLETE` for the whole request while indexing), validates every
item against that projection before applying any (`NOT_OPEN`, `STALE`,
`DUPLICATE`, and every parameter check that needs no disk read), then applies
the valid ones in order — each its own journal transaction, continuing past a
failure unless `stopOnError`. Nothing rolls a sibling back. The response is:

```json
{
  "ok": true, "applied": 37, "failed": 2, "notAttempted": 0, "dryRun": false,
  "results": [
    { "discrepancyId": "…", "ok": true, "decision": { }, "written": ["team"], "git": { } },
    { "discrepancyId": "…", "ok": false, "status": 409, "code": "STALE", "error": "…" }
  ],
  "git": { "layer": "team", "commits": 12, "pushed": true, "queued": false },
  "suggestions": [ ]
}
```

- `ok` is true only when nothing failed and nothing was left unattempted.
- `failed` counts items that were validated or attempted and refused;
  `notAttempted` counts items the batch never reached: `SKIPPED` after a
  failure with `stopOnError` (or after a write that requires recovery), and
  `BATCH_TIME_BUDGET` once the batch has been applying for longer than its
  time budget (10 s under the manifest lock — never before the first attempt).
  Resubmit those.
- `dryRun: true` runs every item's pre-checks and answers
  `wouldWrite: [{ layer, path, created? }]` per item without touching a file,
  the decision log, or git.
- The live layer is pushed once for the whole batch, after the lock is
  released; `git.commits` counts the pathspec commits it made.
- `suggestions` are the rule suggestions the new decisions support (the same
  shape `GET /api/discrepancy-rules` returns), so "create a rule from this
  group" reuses the evidence-backed path.

## Governed rules

- `GET /api/discrepancy-rules` lists effective rules and suggestions with their
  supporting decision IDs.
- `POST /api/discrepancy-rules` accepts a current `suggestionId` and creates a
  local recommendation.
- `PATCH /api/discrepancy-rules?id=…` enables/disables a rule or changes its
  mode between `recommend` and `automatic`.
- `POST /api/discrepancy-rules/promote` first returns a preview. Repeat with
  `confirm: true` to commit it to the live team layer.

A rule matches on `kind`, `conceptType`, `key`, `sources`, and — for a broken
link — the exact `target`. Its action is `prefer_source` (content conflicts),
`acknowledge`, or `rewrite_link { newTarget }` (broken links only). A
broken-link rule only may generalize `conceptType` and `key` to the wildcard
`*`; the miner offers that as a separate `generalized: true` suggestion only
when three or more consistent decisions span at least two distinct
(conceptType, key) pairs. The target is never a wildcard, and no other kind
may use one. Rules that disagree — including a wildcard rule and an exact
rule — disable automation for the records they both match.

Rules contain structural match metadata and decision IDs only. They never
contain source values, excerpts, notes, or prompts. Team rules are always
stored in recommendation mode; automatic use is enabled separately by each
local profile.

Automatic actions run only after indexing settles, with healthy sources, a
current revision, and exactly one unambiguous action, and apply as one batch
per pass (each item re-checked under the lock, at most 500 per pass). A blocked
attempt is audited and is not retried for the same revision; a `rewrite_link`
rule whose destination no longer exists blocks rather than acknowledging.

## Compatibility

`POST /api/conflict-resolutions` continues to accept the legacy choose-layer
section workflow. Existing `conflicts[]` fields remain present. Resolved/MCP
sections may add a `discrepancy` object so an agent can distinguish an open
disagreement from an acknowledged scoped difference.
