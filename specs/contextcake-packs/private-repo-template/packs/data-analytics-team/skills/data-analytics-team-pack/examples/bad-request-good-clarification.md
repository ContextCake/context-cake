---
type: example
updated: 2026-07-06
---

# Bad Request, Good Clarification {#bad-request-good-clarification}

A side-by-side of what happens when a vague stakeholder request goes straight to a
build versus when it goes through `workflows/request-clarification.md` first.
Fictional company, fictional numbers — Northwind.

## The request {#the-request}

Slack message from a Northwind customer success manager:

> "Can I get the churn numbers?"

Five words. No definition, no window, no source, no audience. This is a
`glossary/stakeholder-request.md` in its rawest form — and it's an easy one to get
wrong, because "churn" sounds precise even though it isn't defined.

## The bad path {#the-bad-path}

An analyst under deadline pressure skips clarification and builds immediately, making
silent assumptions to keep moving:

- **Assumes** "churn" means logo churn (accounts lost), when the CS manager was actually
  asking about revenue churn for a renewal-risk conversation.
- **Assumes** a trailing-3-month window because that's what the last churn request used,
  with no basis for this one.
- **Pulls from the CRM** because it's the fastest system to query, not the billing
  system — see `policies-and-rules/source-of-truth-precedence.md` on why that's the
  wrong default for anything revenue-shaped.
- **Skips validation** — no reconciliation to a control number, no record-count check,
  ships straight from query to Slack reply.

The number gets sent back as a single figure with no method, no confidence, and no
caveats. Two days later the CS manager forwards it to their VP, who asks "is this logo
churn or revenue churn?" — and the analyst can't say for certain which one they
computed, because the assumption was never written down. The number gets pulled back and
redone, costing more time than clarifying up front would have.

## The good path {#the-good-path}

Same request, run through `workflows/request-clarification.md` using the prompts in
`prompt-guides/clarifying-a-stakeholder-request.md`. The analyst asks three questions
before touching a query:

1. "When you say churn, do you mean accounts lost (logo churn) or revenue lost (revenue
   churn)?"
2. "What's this for — a specific conversation or a standing report?"
3. "What time window matters — this month, this quarter, trailing 12 months?"

The CS manager clarifies: revenue churn, for a renewal-risk conversation with a specific
at-risk account's account executive, trailing 3 months, ahead of Thursday's account
review.

That turns into a clarified spec using `templates/clarified-spec-template.md`:

**Request (verbatim):** "Can I get the churn numbers?"
**Decision it informs:** Renewal-risk conversation with an account executive ahead of
Thursday's account review.
**Question (restated):** How much recognized MRR was lost to contraction and churn over
the trailing 3 months?
**Metric definition(s):** Revenue churn (contraction + full churn), not logo churn. See
`glossary/metric-definitions.md`.
**Source of truth:** The billing system, not the CRM — per
`policies-and-rules/source-of-truth-precedence.md`.
**Grain:** Monthly.
**Filters / segments:** Contraction and churn only; excludes new and expansion.
**Time window:** Trailing 3 months.
**Acceptance criteria:** Monthly totals reconcile to the billing system's finance-blessed
churn figure within tolerance.
**Deadline:** Wednesday end of day, ahead of Thursday's account review.
**Owner:** CS manager (requester).
**Open questions:** None — definition and window confirmed directly.

Built and validated against the billing system per `workflows/build-and-validate.md` and
`templates/validation-checklist-template.md`, then delivered as an insight summary with
a headline answer, confidence level, and named caveats — not a bare number in a Slack
reply.

## The difference {#the-difference}

The bad path was faster by about ten minutes and slower by two days once the rework is
counted. The good path spent those ten minutes turning an ambiguous word — "churn" —
into a named metric definition and a named source of truth, both written down where the
next person to touch this request can see them. That's the entire value of
`workflows/request-clarification.md`: it's cheap insurance against building the right
answer to the wrong question.
