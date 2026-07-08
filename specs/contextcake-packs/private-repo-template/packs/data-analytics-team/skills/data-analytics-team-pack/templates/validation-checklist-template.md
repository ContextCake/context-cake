---
type: template
updated: 2026-07-06
---

# Validation Checklist Template {#validation-checklist-template}

Copy this checklist for every build before you deliver it. Work through all three
groups in order — definitions and scope come first because reconciliation against the
wrong definition just produces a confidently wrong number. See
`workflows/build-and-validate.md` for the full validate phase and
`policies-and-rules/source-of-truth-precedence.md` for resolving source conflicts.

Attach the completed checklist (or a link to it) to the deliverable — an insight
summary without an attached checklist has not been validated.

## Definitions & scope {#definitions-scope}

- [ ] Source of truth identified _[e.g., billing system confirmed, not the CRM]_
- [ ] Metric definition matches the agreed definition _[e.g., committed MRR, matches `glossary/metric-definitions.md`]_
- [ ] Grain correct _[e.g., one row per account per month, not per subscription line]_
- [ ] Filters / segments applied correctly _[e.g., internal test accounts excluded]_

## Reconciliation {#reconciliation}

- [ ] Record counts reconcile _[e.g., row count matches expected account count for the period]_
- [ ] Totals reconcile to a source-of-truth control number _[e.g., monthly MRR total matches billing system's finance-blessed figure]_
- [ ] Sample rows spot-checked _[e.g., 5 accounts traced by hand from source system to output]_
- [ ] Nulls & duplicates checked _[e.g., no unexpected NULLs in metric or key columns, no duplicate account-month rows]_
- [ ] Date boundaries / time zone correct _[e.g., month boundaries use billing system's close date, not UTC midnight]_

## Reproducibility & review {#reproducibility-review}

- [ ] Result is reproducible _[e.g., saved query or notebook, not a one-off scratchpad run]_
- [ ] Peer reviewed _[e.g., a second analyst re-ran the query and confirmed the totals]_
