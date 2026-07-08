---
type: glossary
updated: 2026-07-06
---

# Clarified Spec {#clarified-spec}

## Definition {#definition}

A clarified spec is the written, scoped version of a stakeholder request: the raw
question plus everything an analyst needs to build and validate an answer without
guessing. It is the output of the Clarify phase and the input to the Build phase.

## Why it matters {#why-it-matters}

The clarified spec is what turns "how is MRR trending?" into something you can actually
query. Skipping it doesn't save time — it just moves the scoping conversation from before
the build (cheap) to after delivery, when the stakeholder challenges the number (expensive,
and now it looks like an error rather than a scoping step). A written spec also gives you
something concrete to send back to the stakeholder for a fast confirm before you spend
build time on the wrong definition.

## Canonical fields {#canonical-fields}

Every clarified spec uses the same field names, in this order: Request (verbatim) ·
Decision it informs · Question (restated) · Metric definition(s) · Source of truth · Grain
· Filters / segments · Time window · Acceptance criteria · Deadline · Owner · Open
questions. Use `templates/clarified-spec-template.md` to fill these in — don't
reinvent the field set per request, the consistency is what makes specs easy to review and
compare later.

Two fields are worth calling out because they're the ones people skip: **Decision it
informs** forces you to ask why the number matters before you build it, which shapes
everything downstream (a board-deck number needs tighter validation than a quick
directional check). **Open questions** is where you park anything you couldn't resolve
before the deadline — better an explicit gap than a silent assumption.

## Northwind example {#northwind-example}

For the VP of Sales's MRR question, the clarified spec records: Decision — the quarterly
board deck; Question — is MRR trending up or down, and why; Metric definition — committed
MRR (not recognized revenue); Source of truth — the billing system; Grain — monthly;
Filters/segments — new, expansion, contraction, churn; Time window — trailing 12 months;
Acceptance criteria — reconciles to the billing system's finance-blessed total within
rounding. The VP confirms this in two Slack messages before any query is written.

## See also {#see-also}

- `templates/clarified-spec-template.md`
- `glossary/stakeholder-request.md`
- `workflows/request-clarification.md`
