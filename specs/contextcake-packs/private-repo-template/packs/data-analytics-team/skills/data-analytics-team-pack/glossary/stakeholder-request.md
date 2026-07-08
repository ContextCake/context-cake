---
type: glossary
updated: 2026-07-06
---

# Stakeholder Request {#stakeholder-request}

## Definition {#definition}

A stakeholder request is the raw, as-received ask from someone outside the analytics
team — a question, a Slack message, a meeting action item — before it has been scoped
into a clarified spec. It is the input to the Clarify phase, not the thing you build
against.

## Why it matters {#why-it-matters}

Stakeholder requests are almost always underspecified on purpose: the person asking
isn't thinking about metric definitions, source systems, or grain, they're thinking about
a decision they need to make. Treating the raw request as if it were already a build spec
is the single most common source of rework — you build the wrong thing correctly, ship
it, and get sent back to start over once the stakeholder sees a number that doesn't match
what they meant. Capturing the request verbatim, before you interpret it, also gives you
something to check your clarified spec against later if the stakeholder disputes the
framing.

## Handling a request {#handling-a-request}

Record the request verbatim as the first field of the clarified spec (see
`glossary/clarified-spec.md`) before you start interpreting it. Resist the urge to
silently "fix" the question while writing it down — if it's ambiguous, that ambiguity is
exactly what clarification is for. The full intake process lives in
`workflows/request-clarification.md`.

## Northwind example {#northwind-example}

Northwind's VP of Sales messages the analytics team: *"How is MRR trending?"* That's the
stakeholder request — five words, no definition of MRR, no time window, no stated
decision. It is recorded exactly as sent. The analyst does not guess at "trailing 12
months, committed MRR" and start building; that interpretation happens explicitly in the
next step, and gets written down as its own field so the VP can confirm or correct it.

## See also {#see-also}

- `glossary/clarified-spec.md`
- `workflows/request-clarification.md`
- `examples/worked-example-mrr-request.md`
