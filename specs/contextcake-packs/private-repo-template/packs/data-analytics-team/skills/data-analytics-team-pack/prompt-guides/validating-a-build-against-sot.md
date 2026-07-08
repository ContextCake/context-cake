---
type: prompt-guide
updated: 2026-07-06
---

# Validating a Build Against Source of Truth {#validating-a-build-against-sot}

Use an AI assistant to help design the validation checks for a build and reason about a
discrepancy — without ever pasting the underlying customer data into the tool. The
assistant is good at generating reconciliation queries and hypotheses for why two
numbers disagree; it does not need to see a single row of real data to do either. See
`workflows/build-and-validate.md` for the full validate phase and
`templates/validation-checklist-template.md` for the canonical checklist.

## The rule this prompt guide follows {#the-rule}

Never paste raw customer data, account-level detail, or row-level exports into an
external AI tool, even to ask "why doesn't this reconcile?" Aggregate numbers, schemas,
column names, query logic, and synthetic examples are safe to share. See
`policies-and-rules/pii-and-access-boundaries.md` for the full boundary and what
"aggregate" means in practice.

## What to paste in {#what-to-paste-in}

- The clarified spec's metric definition, source of truth, grain, filters, and time
  window (from `templates/clarified-spec-template.md`).
- Your query or model logic (SQL, dbt model, notebook cell) with table and column names
  — schema, not data.
- The control number from the source of truth and your build's total, as aggregate
  figures (e.g. "control: 1,842 accounts; build: 1,791 accounts").
- Never: customer names, emails, account IDs tied to real entities, or exported rows.

## Prompt scaffold — designing checks {#prompt-scaffold-designing-checks}

```text
I'm validating a build against a source-of-truth control number. Help me design the
reconciliation checks before I run them.

Metric definition: <e.g. committed MRR per billing system subscription schedule>
Source of truth: <system name>
Grain: <e.g. monthly, one row per account per month>
Filters / segments: <e.g. exclude internal test accounts>
My query logic (schema only, no data): <paste SQL/dbt/notebook snippet>

Walk through the canonical validation checklist and tell me, for each item, what
specific check I should run against this build:
- source of truth identified
- metric definition matches the agreed definition
- grain correct
- filters / segments applied correctly
- record counts reconcile
- totals reconcile to a source-of-truth control number
- sample rows spot-checked
- nulls & duplicates checked
- date boundaries / time zone correct
- result is reproducible
- peer reviewed

Flag anything in my query logic that looks like it could cause a mismatch (e.g. join
fan-out, timezone truncation, off-by-one date boundaries).
```

## Prompt scaffold — reconciling a discrepancy {#prompt-scaffold-reconciling-a-discrepancy}

```text
My build's total doesn't match the source-of-truth control number. Help me generate
hypotheses, using only these aggregate figures -- no raw data.

Control (source of truth): <aggregate number, e.g. 1,842 accounts>
Build result: <aggregate number, e.g. 1,791 accounts>
Difference: <e.g. -51 accounts, -2.8%>
Metric definition and filters in use: <paste>
Known recent changes: <e.g. upstream table added a new status value last week>

List the most likely causes ranked by probability (definition drift, filter mismatch,
grain mismatch, timezone/date-boundary issue, join fan-out or row loss, stale data), and
for each one tell me the specific aggregate check that would confirm or rule it out.
```

## After the model responds {#after-the-model-responds}

The assistant can narrow down where to look; it cannot confirm the fix without you
running the checks against real data yourself, inside your own environment. Once
reconciled, record what caused the discrepancy — if it was a metric definition change,
route it through `policies-and-rules/metric-change-control.md` so it doesn't silently
recur.
