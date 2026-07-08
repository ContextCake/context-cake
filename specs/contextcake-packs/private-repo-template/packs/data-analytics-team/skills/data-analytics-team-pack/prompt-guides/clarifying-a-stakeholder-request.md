---
type: prompt-guide
updated: 2026-07-06
---

# Clarifying a Stakeholder Request {#clarifying-a-stakeholder-request}

Use an AI assistant (Claude, ChatGPT, Cursor, Copilot) to turn a vague request into a
complete draft of the clarified spec before you talk to the stakeholder. The assistant
is a drafting partner, not a decision-maker — it proposes fields and flags gaps; you and
the stakeholder confirm the values, especially source of truth and metric definition.
See `workflows/request-clarification.md` for the full clarify phase and
`templates/clarified-spec-template.md` for the fields this prompt fills in.

## Why prompt for this instead of just asking the stakeholder {#why-prompt-for-this}

Stakeholders describe outcomes, not specs ("how is MRR trending?"). An AI assistant is
good at turning that sentence into the full list of questions a spec requires, so you
walk into the clarifying conversation with a checklist instead of improvising it live.
It also catches missing fields you'd otherwise discover mid-build.

## What to paste in {#what-to-paste-in}

The stakeholder's request verbatim, plus any context you already have: who asked, what
channel, any decision they mentioned, and rough deadline. Do not paste raw customer data
or account-level detail — a one-line request rarely contains any, but if the stakeholder
pasted a spreadsheet excerpt into Slack, summarize it in your own words instead of
forwarding it. See `policies-and-rules/pii-and-access-boundaries.md`.

## Prompt scaffold {#prompt-scaffold}

```text
I received this stakeholder request and need to turn it into a clarified spec before
I build anything.

Request (verbatim): <paste exact wording>
Who asked / channel: <name/role, e.g. VP of Sales, via Slack>
Any context they gave: <optional>

Draft a clarified spec with these fields, using "unknown" for anything you cannot infer
and listing it under Open questions instead of guessing:

- Request (verbatim)
- Decision it informs
- Question (restated) -- a precise, answerable version of the ask
- Metric definition(s) -- name every metric and flag any ambiguous variant (e.g.
  committed vs. recognized revenue, trial vs. paid accounts)
- Source of truth -- the system whose number should govern; flag if more than one
  plausible system exists
- Grain -- aggregation level and row-level unit
- Filters / segments -- inclusions, exclusions, breakouts
- Time window -- exact range, rolling or fixed
- Acceptance criteria -- what "done" looks like, concretely
- Deadline
- Owner -- analyst and stakeholder contact
- Open questions -- everything still unresolved

Flag every field where you had to guess rather than infer directly from the request.
```

## After the model responds {#after-the-model-responds}

Treat the draft as a starting point for the clarifying conversation, not a finished
spec. The model cannot tell you which system is actually the source of truth at your
company, or what the stakeholder really meant by "trending" — those are decisions you
confirm with a human, then record in `templates/clarified-spec-template.md`. Do not
start building on any field still marked "unknown" if it affects the metric definition,
source of truth, or grain.
