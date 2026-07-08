---
type: template
updated: 2026-07-06
---

# Clarified Spec Template {#clarified-spec-template}

## How to use this {#how-to-use-this}

Copy this file for every new stakeholder request and fill in each section before you
start building. If a field is genuinely unknown, write "unknown" and add it to
**Open questions** — do not leave it blank. See `workflows/request-clarification.md`
for how to run the clarifying conversation, and `examples/worked-example-mrr-request.md`
for a filled-in version of this template.

## Request (verbatim) {#request-verbatim}

The stakeholder's ask, copied exactly as they wrote or said it. Do not paraphrase here —
paraphrasing is where assumptions creep in.

_[e.g., "Can you send me a chart of how MRR is trending?" — from Slack, VP of Sales]_

## Decision it informs {#decision-it-informs}

What the stakeholder will do with the answer. If there's no decision attached, ask why
the request exists before building anything.

_[e.g., input to the quarterly board deck, narrative on growth trajectory]_

## Question (restated) {#question-restated}

The request rewritten as a precise, answerable question, in your own words.

_[e.g., "What has committed MRR done, by month, for the trailing 12 months, broken out by new / expansion / contraction / churn?"]_

## Metric definition(s) {#metric-definitions}

The exact definition of every metric involved, including which variant (e.g. committed
vs. recognized). Link to `glossary/metric-definitions.md` entries where they exist.

_[e.g., MRR = committed MRR per the billing system's subscription schedule, not recognized revenue]_

## Source of truth {#source-of-truth}

The single system whose numbers govern this metric. See
`policies-and-rules/source-of-truth-precedence.md` if two systems disagree.

_[e.g., billing system (Northwind Billing), not the CRM]_

## Grain {#grain}

The level of aggregation and the row-level unit the analysis is built from.

_[e.g., monthly, one row per account per month]_

## Filters / segments {#filters-segments}

Inclusion/exclusion rules and any breakouts the stakeholder needs.

_[e.g., exclude internal test accounts; segment by new / expansion / contraction / churn]_

## Time window {#time-window}

The exact date range, and whether it's rolling or fixed.

_[e.g., trailing 12 months, rolling, closed on the last completed month]_

## Acceptance criteria {#acceptance-criteria}

What "done" looks like, concretely enough that both you and the stakeholder would agree
the deliverable meets it.

_[e.g., monthly MRR total reconciles to the billing system's finance-blessed number within $0]_

## Deadline {#deadline}

When the stakeholder needs this, and whether that date is negotiable.

_[e.g., end of day Thursday, ahead of Friday's board prep review]_

## Owner {#owner}

Who is accountable for this request on the analytics side, and who the stakeholder
contact is.

_[e.g., analyst: you; stakeholder: VP of Sales]_

## Open questions {#open-questions}

Anything still unresolved. Do not start building with unresolved items that affect the
metric definition, source of truth, or grain — resolve those first.

_[e.g., does "trending" mean a line chart or a table? confirm with stakeholder]_
