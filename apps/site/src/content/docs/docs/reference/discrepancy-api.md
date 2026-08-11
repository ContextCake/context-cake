---
title: Discrepancy API
description: Structural detection, transactional decisions, and governed local or team rules.
---

The engine service exposes the Discrepancy Center through additive JSON APIs.
The original resolver output and `/api/conflict-resolutions` endpoint remain
available for compatibility.

## Detection

`GET /api/discrepancies` returns structural `section_content`,
`frontmatter_value`, `broken_link`, and `changed_after_decision` records. Every
record includes a stable ID, current revision, deterministic winner reason,
all values and fingerprints, source health, owner, priority, status, history,
and matching rules. `coverageComplete: false` means broken-link detection has
been paused because at least one required source is still indexing or unhealthy.

`PATCH /api/discrepancies?id=…` accepts `{ "priority": "high" }`; allowed
values are `unassigned`, `high`, `medium`, and `low`. Priority is explicitly
assigned by a user and does not affect resolver precedence.

## Decisions

`POST /api/discrepancy-decisions` requires `discrepancyId`, the displayed
`revision`, and one action:

- `choose_contribution` with `selectedSource`
- `compose` with Markdown `content`
- `acknowledge` with `reasonCode` and an optional local `note`

Acknowledgement reason codes are `different_scopes`, `temporary_migration`,
`source_specific_authority`, `target_missing`, and `other`. `target_missing`
is the console's dedicated reason for `broken_link` discrepancies.
Acknowledgement writes no source content. Write actions preflight every writable
target, journal a prepared transaction, keep recoverable originals beside each
file, and either commit the complete set or report rollback/recovery state
precisely.

Records append as schema v2 to
`.contextcake/profiles/<profile-id>/conflict-resolutions.ndjson` (the default
profile uses `profiles/default/`; pre-profile files migrate there on first
access). Existing schema-v1 records are read unchanged. Transaction states
append to `.contextcake/profiles/<profile-id>/discrepancy-transactions.ndjson`.

## Governed rules

- `GET /api/discrepancy-rules` lists effective rules and suggestions with their
  supporting decision IDs.
- `POST /api/discrepancy-rules` accepts a current `suggestionId` and creates a
  local recommendation.
- `PATCH /api/discrepancy-rules?id=…` enables/disables a rule or changes its
  mode between `recommend` and `automatic`.
- `POST /api/discrepancy-rules/promote` first returns a preview. Repeat with
  `confirm: true` to commit it to the live team layer.

Rules contain structural match metadata and decision IDs only. They never
contain source values, excerpts, notes, or prompts. Team rules are always
stored in recommendation mode; automatic use is enabled separately by each
local profile.

Automatic actions run only after indexing settles, with healthy sources, a
current revision, and exactly one unambiguous action. A blocked attempt is
audited and is not retried for the same revision.

## Compatibility

`POST /api/conflict-resolutions` continues to accept the legacy choose-layer
section workflow. Existing `conflicts[]` fields remain present. Resolved/MCP
sections may add a `discrepancy` object so an agent can distinguish an open
disagreement from an acknowledged scoped difference.
