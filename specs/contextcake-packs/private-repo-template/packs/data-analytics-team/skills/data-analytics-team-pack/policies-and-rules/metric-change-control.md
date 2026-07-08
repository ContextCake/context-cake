---
type: policy
updated: 2026-07-06
---

# Metric Change Control {#metric-change-control}

A metric definition is a contract: everyone downstream assumes it means what it meant
last week. This policy governs how a definition is proposed, reviewed, versioned, dated,
and communicated when it needs to change — so a redefinition never reaches a stakeholder
as a silent, unexplained jump in a familiar number. See
`glossary/metric-definitions.md` for how definitions are documented day to day.

## Why silent redefinitions are dangerous {#why-silent-redefinitions-are-dangerous}

At Northwind, a weekly executive dashboard's "active accounts" figure jumped roughly 20%
week over week. Nothing about actual usage had changed — an engineer had widened the
upstream `active` flag to include trial accounts, to fix an unrelated reporting gap. The
dashboard kept running without error and produced a plausible-looking number, which is
what made it dangerous: nobody was prompted to question it until a stakeholder asked why
active accounts suddenly beat forecast. The fix wasn't technical — the flag change was
reasonable in isolation — it was that nobody proposed, reviewed, or announced it as a
metric definition change.

Every silent redefinition costs trust even after it's explained, because it retroactively
puts every past report in doubt: if this number moved without anyone knowing, which
others already have?

## How a change is proposed {#how-a-change-is-proposed}

1. Anyone who wants to change a metric definition — including an engineer changing an
   upstream field a metric depends on — writes a short proposal: current definition, new
   definition, reason for the change, and which dashboards/reports/models depend on it.
2. Search for the metric's existing entry in `glossary/metric-definitions.md` and any
   report that references it before proposing — you need the full blast radius, not just
   the report you're currently working on.

## How a change is reviewed {#how-a-change-is-reviewed}

1. At least one other analyst or the team's technical manager reviews the proposal
   against every known consumer of the metric.
2. Reviewers check whether the change should be a new metric (e.g. `active_accounts_v2`)
   instead of a redefinition in place — this is usually the safer choice when historical
   comparability matters, such as board-level trend metrics.
3. If the metric feeds an insight summary that's already been delivered, flag whether
   past deliverables need a retroactive caveat.

## How a change is versioned and dated {#how-a-change-is-versioned-and-dated}

- Update `glossary/metric-definitions.md` with the new definition, the effective date,
  and a note of what the prior definition was — do not overwrite history, append to it.
- If the change breaks comparability with prior periods, say so explicitly next to the
  definition (e.g. "not comparable to weeks before 2026-06-30").
- Prefer a new metric name over a silent redefinition whenever a trend line or
  board-level number depends on the old definition holding steady.

## How a change is communicated {#how-a-change-is-communicated}

- Announce the change to the team and to any stakeholder who regularly consumes the
  metric, before it goes live wherever possible — not after someone notices the jump.
- Any dashboard or report affected gets an annotation at the date of the change, not just
  a mention in a Slack thread that will scroll away.
- If a build's validation surfaces an unexpected jump, treat metric definition drift as a
  standing hypothesis — check `glossary/metric-definitions.md`'s last-updated date for
  every metric involved before looking elsewhere. See
  `templates/validation-checklist-template.md`.
