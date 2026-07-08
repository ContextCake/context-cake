---
type: workflow
updated: 2026-07-06
---

# Request Clarification {#request-clarification}

Phase 1 of `workflows/stakeholder-request-to-insight.md`. Goal: turn a stakeholder
request (see `glossary/stakeholder-request.md`) into a written clarified spec (see
`glossary/clarified-spec.md`) that both sides agree on before any query is written.

## Why this phase exists {#why-this-phase-exists}

Most bad analytics work isn't a bad query — it's a correct answer to the wrong question.
"How is MRR trending?" can mean five different things depending on which MRR definition,
which source system, and which time window the stakeholder has in mind. Guessing any of
those wrong wastes a build cycle and erodes trust. Clarifying first is cheaper than
rebuilding later.

## Questions to ask {#questions-to-ask}

Work through the canonical clarified-spec fields. Don't skip a field because it seems
obvious — obvious to you is not the same as agreed with the stakeholder.

- **Request (verbatim):** What did they actually type or say? Capture it word for word
  before you paraphrase anything.
- **Decision it informs:** What will this answer be used for? A board deck, a headcount
  call, a one-off curiosity? This sets the bar for rigor and turnaround time.
- **Question (restated):** Play the question back in your own words and get confirmation.
  This alone catches half of all misunderstandings.
- **Metric definition(s):** For Northwind's "MRR," ask: committed or recognized? Does it
  include one-time fees? How are annual contracts normalized to monthly?
- **Source of truth:** Which system is authoritative — the billing system or the CRM? See
  `policies-and-rules/source-of-truth-precedence.md` if the stakeholder isn't sure.
- **Grain:** Monthly, weekly, daily? Per account, per segment, aggregate?
- **Filters / segments:** New, expansion, contraction, churn? Specific regions, plans, or
  customer tiers excluded or included?
- **Time window:** Trailing 12 months? Fiscal year to date? A specific quarter?
- **Acceptance criteria:** What does "answered" look like? A number, a chart, a trend line
  with commentary?
- **Deadline:** When is it needed, and is that a hard or soft date?
- **Owner:** Who on the stakeholder side can answer follow-up questions if something's
  ambiguous mid-build?
- **Open questions:** Anything still unresolved — log it rather than silently assuming.

## Pushing back on vague requests {#pushing-back-on-vague-requests}

A one-line Slack message is not a spec. When a request arrives underspecified:

- Don't start building "something reasonable" and hope it matches. Ask first.
- Offer a default and ask for confirmation rather than an open-ended question, when you
  can: "I'll use committed MRR from the billing system, monthly grain, trailing 12
  months — does that match what you need?" This is faster for the stakeholder to answer
  than a blank-page question.
- If the stakeholder pushes back on the clarification step itself ("just give me a
  number"), explain the cost of guessing wrong once, then hold the line — a five-minute
  conversation now is cheaper than a retracted number in a board deck.
- Escalate to a synchronous conversation (call, not chat) if written back-and-forth stalls
  after two rounds.

## Output {#output}

A filled `templates/clarified-spec-template.md`, shared back with the stakeholder for
explicit sign-off — not just sent and assumed read. Move to
`workflows/build-and-validate.md` only after sign-off.
