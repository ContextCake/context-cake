---
type: glossary
updated: 2026-07-06
---

# Metric Definitions {#metric-definitions}

## Definition {#definition}

A metric definition is the precise, written rule for how a named metric is calculated:
what counts, what doesn't, and what edge cases resolve which way. "MRR" is not a metric
definition. "Committed MRR: the sum of active subscription contract values as of month-end,
excluding trials, in the billing system's base currency" is.

## Why it matters {#why-it-matters}

Most metric names are ambiguous even inside a single company. "Active accounts,"
"revenue," "churn" — each of these has multiple defensible definitions, and different
systems often compute them differently by default. A metric definition removes the
ambiguity once, in writing, so the analyst building a report and the stakeholder reading
it are talking about the same number. Definitions also drift: someone changes what
`active` means in a source table, and every downstream report silently starts answering a
different question. That's why definitions need a change-control process, not just an
initial write-up — see `policies-and-rules/metric-change-control.md`.

## Using metric definitions {#using-metric-definitions}

Record the specific definition in play as part of every clarified spec (the "Metric
definition(s)" field — see `glossary/clarified-spec.md`), even for metrics your team
considers standard. During validation, confirm the build actually implements the stated
definition, not just a plausible one (see `glossary/validation-pass.md`). If a stakeholder's
implicit definition differs from your team's standard one, that's a clarification
conversation, not a silent judgment call.

## Northwind example {#northwind-example}

Northwind's dashboard has tracked "active accounts" for two years using the definition
"accounts with a paid subscription in the billing system." An engineer updates the
`active` flag in the product database to also include accounts in an active trial, to
support a different feature. The dashboard, which reads that flag directly instead of the
billing system, jumps 20% overnight with no change in actual paying customers. The jump
gets caught during the weekly validation pass because the dashboard total no longer
reconciles to the billing system's account count — the metric definition changed
underneath the report without going through change control.

## See also {#see-also}

- `policies-and-rules/metric-change-control.md`
- `glossary/clarified-spec.md`
- `glossary/source-of-truth.md`
