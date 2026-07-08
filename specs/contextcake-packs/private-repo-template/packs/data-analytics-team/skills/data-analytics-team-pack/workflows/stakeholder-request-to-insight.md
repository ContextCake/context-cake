---
type: workflow
updated: 2026-07-06
---

# Stakeholder Request to Insight {#stakeholder-request-to-insight}

This is the hero workflow of the pack: the path from a vague stakeholder question to a
trustworthy, delivered answer. It has four phases. Every request that reaches your team,
big or small, should move through all four — the depth you apply to each phase scales with
the stakes of the decision, but skipping a phase is how wrong numbers reach a board deck.

The running example throughout this pack: Northwind's VP of Sales asks "How is MRR
trending?" See `examples/worked-example-mrr-request.md` for the full walkthrough.

## The four phases {#the-four-phases}

1. **Clarify** — turn a vague stakeholder request into a written clarified spec.
2. **Build** — produce the query, model, or report against that spec.
3. **Validate** — reconcile the build to the source of truth.
4. **Deliver** — write an insight summary: answer, confidence, caveats, next action.

## Phase 1: Clarify {#phase-1-clarify}

**What happens:** You take the stakeholder's raw request — usually a Slack message or a
sentence in a meeting — and turn it into a written clarified spec covering metric
definition, source of truth, grain, filters, time window, acceptance criteria, deadline,
and owner. You do not start building until this is filled in and agreed.

**Who owns it:** The analyst who received the request, with the requesting stakeholder
answering questions. Neither side proceeds unilaterally — the analyst doesn't guess, the
stakeholder doesn't hand off and disappear.

**Artifact produced:** A filled `templates/clarified-spec-template.md`.

Full detail: `workflows/request-clarification.md`.

## Phase 2: Build {#phase-2-build}

**What happens:** You write the query or model strictly against the clarified spec — same
metric definition, same source, same grain, same filters, same window. No scope creep, no
"while I'm in here" additions. If the build reveals the spec was ambiguous or wrong, you
go back to Phase 1 rather than resolve the ambiguity silently in code.

**Who owns it:** The analyst or analytics engineer doing the work.

**Artifact produced:** A draft query, notebook, or model — not yet trusted, not yet shared.

## Phase 3: Validate {#phase-3-validate}

**What happens:** You reconcile the build's output against the source of truth identified
in the clarified spec: totals match a control number, record counts reconcile, a sample of
rows is spot-checked, nulls and duplicates are checked, date boundaries and time zones are
verified, and — for anything stakes-bearing — a peer reviews it. You do not deliver a
number you haven't reconciled.

**Who owns it:** The builder runs the checklist; a second team member peer-reviews before
anything goes external.

**Artifact produced:** A completed `templates/validation-checklist-template.md`.

Phases 2 and 3 in full detail, with the Northwind MRR reconciliation worked example:
`workflows/build-and-validate.md`.

## Phase 4: Deliver {#phase-4-deliver}

**What happens:** You turn the validated result into a written insight summary — headline
answer, confidence level with a reason, key numbers, what it means for the decision named
in the clarified spec, caveats, method, and a next action. You send the summary, not a raw
screenshot or an unannotated dashboard link.

**Who owns it:** The analyst who ran the work, reviewed by whoever owns the stakeholder
relationship if the result is going to leadership.

**Artifact produced:** A filled `templates/insight-summary-template.md`.

Full detail: `workflows/insight-delivery.md`.

## Recurring requests {#recurring-requests}

Reports and dashboards you rebuild on a schedule follow a variant of this loop rather than
starting from Phase 1 each time. See `workflows/recurring-report-refresh.md`.

## Reference {#reference}

- `templates/clarified-spec-template.md`
- `templates/validation-checklist-template.md`
- `templates/insight-summary-template.md`
- `policies-and-rules/source-of-truth-precedence.md`
