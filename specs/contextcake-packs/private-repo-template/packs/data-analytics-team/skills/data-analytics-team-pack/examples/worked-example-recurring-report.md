---
type: example
updated: 2026-07-06
---

# Worked Example: Recurring Report Break {#worked-example-recurring-report}

A second worked case: not a new request, but a standing report that quietly went wrong.
This is the failure mode `workflows/recurring-report-refresh.md` and
`policies-and-rules/metric-change-control.md` exist to catch. Fictional company,
fictional numbers — Northwind.

## The setup {#the-setup}

Northwind's weekly executive dashboard includes "active accounts" — a headline tile the
CEO reads every Monday. The metric has been stable for a year: a straightforward count
of accounts with `status = active` in the product database.

## What broke {#what-broke}

Monday's refresh shows active accounts up ~20% week over week. No unusual sales
activity, no bulk import, nothing in the changelog. The number is implausible on its
face, but it's not obviously wrong either — it just jumped.

This is a recurring-report refresh, not a new stakeholder request, so it runs through
`workflows/recurring-report-refresh.md` rather than a fresh clarify phase — but the same
validation discipline applies.

## Phase 3: Validate catches it {#phase-3-validate-catches-it}

Before the dashboard ships, the analyst runs `templates/validation-checklist-template.md`
as required by the refresh workflow:

- Source of truth identified — product database `accounts` table, unchanged.
- Metric definition matches the agreed definition — **fails here.** The agreed
  definition of "active" (per `glossary/metric-definitions.md`) is a paying,
  non-trial account in good standing. Spot-checking new "active" accounts turns up
  several accounts still in their 14-day trial period.
- Totals reconcile to a source-of-truth control number — the CRM's paid-account count
  (a synthetic control value of **1,240**) does not match the dashboard's new "active"
  count of **1,488** — a 20% gap, well outside tolerance.
- Sample rows spot-checked — confirms trial accounts are present in the new count and
  were absent last week.

The checklist stops the refresh from shipping. Digging into the product database's
schema history: an upstream engineering change three days earlier redefined the
`active` flag to include trial accounts, for an unrelated onboarding-funnel feature. No
one told the analytics team.

## The root cause {#the-root-cause}

This is exactly the scenario `policies-and-rules/metric-change-control.md` exists for:
an upstream system changed a field's meaning without notifying downstream consumers of
that field. The metric name (`active`) stayed the same; the definition underneath it
did not. Nothing in the pipeline itself broke — no errors, no failed job — which is why
it's dangerous. A silent definition change reads as legitimate growth unless someone
reconciles to a control number.

## Fix {#fix}

- Report the discrepancy to the engineering owner of the `active` flag and confirm the
  new field semantics.
- Update the dashboard query to filter explicitly on paying, non-trial status —
  `status = active AND trial_ends_at IS NULL` — restoring the original metric
  definition rather than inheriting whatever the upstream flag happens to mean.
- Log the change per `policies-and-rules/metric-change-control.md` so future
  upstream changes to fields this report depends on get flagged before they ship, not
  after.
- Add a note to the report's saved query documenting the incident and the explicit
  filter, so the next analyst who touches this report understands why the filter is
  more verbose than the flag alone.

## Corrected insight summary {#corrected-insight-summary}

**Headline answer:** Active accounts (paying, non-trial) held flat at 1,240 week over
week — the earlier 1,488 figure was inflated by a silent upstream definition change that
added trial accounts.
**Confidence:** High — reconciled to the CRM's paid-account control number after
correcting the filter.
**Key numbers:** 1,240 active accounts this week vs. 1,235 last week (+0.4%), consistent
with recent trend. The uncorrected figure (1,488) is not usable.
**What it means for the decision:** No change to the growth narrative. Do not circulate
the 1,488 figure that already went out in the earlier draft — send a correction.
**Caveats & assumptions:** Depends on the `active`/`trial_ends_at` fields in the product
database keeping their current meaning; flagged as change-controlled per
`policies-and-rules/metric-change-control.md`.
**Method:** Source — product database `accounts` table, CRM paid-account count as
control. Definition — paying, non-trial account. Window — current week vs. prior week.
**Next action:** Send correction to dashboard recipients; confirm with engineering that
no other downstream reports read the `active` flag without the trial filter.
**Links / appendix:** `workflows/recurring-report-refresh.md`,
`policies-and-rules/metric-change-control.md`, incident note in the report's saved
query documentation.
