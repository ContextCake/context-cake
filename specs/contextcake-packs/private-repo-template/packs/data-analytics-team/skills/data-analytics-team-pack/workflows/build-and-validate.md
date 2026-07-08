---
type: workflow
updated: 2026-07-06
---

# Build and Validate {#build-and-validate}

Phases 2 and 3 of `workflows/stakeholder-request-to-insight.md`. Input: a signed-off
`templates/clarified-spec-template.md`. Output: a reconciled result plus a completed
`templates/validation-checklist-template.md`.

## Phase 2: Build {#phase-2-build}

Build strictly to the clarified spec — the metric definition, source, grain, filters, and
window you agreed with the stakeholder, not what's easiest to query.

**Northwind MRR example:** the clarified spec says committed MRR, billing system as source
of truth, monthly grain, segmented into new / expansion / contraction / churn, trailing 12
months. The analyst writes the extraction against the billing system's subscription
tables, not the CRM's opportunity records — the CRM tracks deals, not billed revenue, and
will not reconcile.

```sql
-- Committed MRR by month and movement segment, billing system as source of truth
select
  date_trunc('month', effective_date) as mrr_month,
  movement_segment, -- new / expansion / contraction / churn
  sum(committed_mrr_amount) as committed_mrr
from billing.subscription_mrr_ledger
where effective_date >= date_trunc('month', current_date) - interval '12 months'
group by 1, 2
order by 1, 2;
```

If the build surfaces a gap in the spec — say, annual contracts normalized inconsistently —
stop and go back to `workflows/request-clarification.md` rather than picking a convention
on your own and moving on.

## Phase 3: Validate {#phase-3-validate}

Validation reconciles your build to the source of truth named in the spec. Never deliver a
number that hasn't cleared this step. Use `templates/validation-checklist-template.md` and
consult `policies-and-rules/source-of-truth-precedence.md` whenever two systems disagree.

**Northwind MRR example, walked through the checklist:**

- **Source of truth identified:** billing system subscription ledger — confirmed in the
  clarified spec, not re-decided here.
- **Metric definition matches:** committed MRR, not recognized — check the ledger's
  `committed_mrr_amount` column, not a revenue-recognition column.
- **Grain correct:** one row per month per segment, matching the spec.
- **Filters/segments applied correctly:** new / expansion / contraction / churn sum to the
  same total as an unsegmented pull for the same month.
- **Record counts reconcile:** subscription row count for the month matches the billing
  system's own admin report count.
- **Totals reconcile to a control number:** finance publishes a blessed monthly MRR figure
  for board reporting — the build's total must match it within an agreed tolerance (for
  example, under 0.5%, attributable to rounding).
- **Sample rows spot-checked:** pull 5 accounts, verify their MRR contribution against the
  billing system UI directly.
- **Nulls & duplicates checked:** no subscription rows with a null `committed_mrr_amount`
  or duplicate `subscription_id` within a month.
- **Date boundaries / time zone correct:** month boundaries use the billing system's
  billing-cycle calendar, not UTC calendar months, if the two differ.
- **Result is reproducible:** the query is saved and versioned, not run ad hoc in a
  scratch tab.
- **Peer reviewed:** a second analyst re-runs the control-number check independently.

If the control-number check fails, do not adjust the build until it matches — find out
why. A mismatch usually means a wrong filter, a definition drift, or a genuinely stale
source; each has a different fix, and silently forcing a match hides the real problem.

## Output {#output}

A build that reconciles to the source of truth, plus a completed validation checklist
attached to the work. Proceed to `workflows/insight-delivery.md` only once every checklist
item passes or has a documented, agreed exception.
