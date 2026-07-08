---
type: workflow
updated: 2026-07-06
---

# Recurring Report Refresh {#recurring-report-refresh}

The loop for reports and dashboards you rebuild on a schedule — weekly, monthly, whatever
cadence the stakeholder needs. This is not a full re-run of
`workflows/stakeholder-request-to-insight.md` from Phase 1 each time. It's a lighter loop
that still protects against the two ways recurring reports quietly go wrong: definitions
drift, or upstream data changes underneath you.

## Why recurring reports need their own loop {#why-recurring-reports-need-their-own-loop}

A one-off request gets full clarification because the risk is understood once, up front. A
recurring report runs unattended for months — nobody re-reads the clarified spec every
Monday. That's exactly how definition drift and silent upstream changes reach a dashboard
unnoticed: the report keeps running, technically correct against last quarter's
assumptions, quietly wrong against this quarter's data.

## The refresh loop {#the-refresh-loop}

1. **Re-confirm definitions.** Before each refresh (or at minimum monthly for
   weekly reports), re-read the original `templates/clarified-spec-template.md` for this
   report. Confirm the metric definition, source of truth, and filters still match what's
   actually in the query. Specs don't self-update when a business definition changes.
2. **Watch for upstream metric changes.** Check whether any upstream system changed a field
   definition, a status flag, or a table schema since the last refresh. Upstream teams
   rarely broadcast this to analytics — you have to ask or watch for it. See
   `policies-and-rules/metric-change-control.md` for how changes should be requested and
   logged, and push back when a change lands without going through that process.
3. **Re-run the validation checklist.** Every refresh gets a full pass of
   `templates/validation-checklist-template.md` — record counts, control-number
   reconciliation, spot checks. A report that validated last month is not guaranteed to
   validate this month; treat each refresh as a new validation, not a rubber stamp.
4. **Deliver only if it reconciles.** If the checklist fails, do not publish the refresh on
   schedule. A late correct number beats an on-time wrong one. Flag the delay and the
   reason to the report owner.

## Worked example: active accounts jumps 20% {#worked-example-active-accounts-jumps-20-percent}

Northwind's weekly executive dashboard shows "active accounts" jumping about 20% week over
week — a swing far outside normal variance. Following the loop:

- **Re-confirm definitions:** the analyst checks the report's clarified spec — "active"
  was defined as paying accounts with a non-canceled subscription. The current query still
  matches that definition on paper.
- **Watch for upstream changes:** the analyst checks the source table and finds the
  `active` flag in the billing system was redefined last week to also include trial
  accounts, as part of an unrelated product change. Nobody notified analytics.
- **Re-run the validation checklist:** the control-number check fails — the new total
  doesn't reconcile against finance's paying-accounts figure, because trials are now mixed
  in.
- **Outcome:** the report is held, the upstream change is logged and routed through
  `policies-and-rules/metric-change-control.md`, and the query is either updated to exclude
  trials explicitly or the report is relabeled if the business now wants trials included.
  Either way, the decision is made deliberately, not inherited silently from an upstream
  flag change.

## Output {#output}

A refreshed, re-validated report delivered on schedule, or a documented hold with a
reason and an owner for the fix. Definition or upstream changes that affect the report get
logged via `policies-and-rules/metric-change-control.md`, not patched quietly in the query.
