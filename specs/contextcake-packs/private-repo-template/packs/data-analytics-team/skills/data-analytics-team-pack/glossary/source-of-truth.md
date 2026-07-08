---
type: glossary
updated: 2026-07-06
---

# Source of Truth {#source-of-truth}

## Definition {#definition}

The source of truth for a metric is the single system whose numbers are authoritative
for that metric — the one you reconcile to when two systems disagree. It is a choice your
team makes and documents, not a property a system has on its own.

## Why it matters {#why-it-matters}

Most contested numbers aren't math errors — they're two people trusting two different
systems that both look reasonable. A CRM's opportunity amounts and a billing system's
invoiced amounts can both be "correct" and still disagree, because they measure different
things (a sale versus a payment). Without a named source of truth, every disagreement
becomes a fresh argument. With one, it becomes a lookup: check the designated system,
done.

## How to choose one {#how-to-choose-one}

Pick the system closest to the actual event, not the system that's easiest to query.
For revenue metrics that's usually the billing or finance system, not the CRM. For product
usage it's usually the event pipeline, not a dashboard that samples it. When a metric
doesn't have an obvious owner, escalate the choice to whoever is accountable for the
decision the metric informs, and record the decision in
`policies-and-rules/source-of-truth-precedence.md` so it doesn't get re-litigated per
request.

## Source of truth vs. system of record {#source-of-truth-vs-system-of-record}

The two terms get used interchangeably, but they answer different questions. A **system
of record** is where data is created and lives operationally — the CRM is the system of
record for opportunity stage, the billing platform is the system of record for invoices.
A **source of truth** is which system you trust for a specific metric's value when systems
disagree. Usually the system of record for the underlying event *is* the source of truth
for metrics derived from it, but not always: a data warehouse that cleans and reconciles
multiple systems can be the source of truth for a metric even though it isn't the system
of record for any of the raw inputs.

## Northwind example {#northwind-example}

Northwind's CRM shows a customer's subscription value the moment a deal closes. Northwind's
billing system shows the value only once the subscription is provisioned and the first
invoice is generated, a few days later. For "current MRR," Northwind's analytics team
designates the billing system as the source of truth — it reflects what's actually being
charged, not what sales expects to charge. The CRM number is still useful for sales
forecasting, but it is not the number that goes in the board deck.

## See also {#see-also}

- `policies-and-rules/source-of-truth-precedence.md`
- `glossary/validation-pass.md`
- `glossary/metric-definitions.md`
