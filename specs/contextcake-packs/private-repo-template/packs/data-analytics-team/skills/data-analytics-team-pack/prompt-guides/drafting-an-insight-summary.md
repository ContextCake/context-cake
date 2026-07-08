---
type: prompt-guide
updated: 2026-07-06
---

# Drafting an Insight Summary {#drafting-an-insight-summary}

Use an AI assistant to draft the prose of an insight summary from a validated result —
never to generate the result itself. By the time you reach this prompt, the build has
already passed validation (`workflows/build-and-validate.md`); the model's job is to
turn your numbers and notes into a clear, well-structured summary using the canonical
fields. See `templates/insight-summary-template.md` and `workflows/insight-delivery.md`.

## The analyst is the editor {#the-analyst-is-the-editor}

The model can draft a headline and phrase caveats cleanly. It cannot judge what the
result means for the decision, how confident to be, or which caveats actually matter —
those require knowing the business context and the stakeholder. Treat every draft as a
first pass you rewrite, not a final answer you forward. You own the headline answer, the
confidence rating, and the next action; the model only helps you say them well.

## What to paste in {#what-to-paste-in}

- The validated result as aggregate numbers (from `templates/validation-checklist-template.md`
  once every check has passed).
- The clarified spec's decision, metric definition, source of truth, and time window.
- Your own read on confidence and caveats — the model should refine these, not invent
  them from nothing.
- No raw data or row-level detail; see `policies-and-rules/pii-and-access-boundaries.md`.

## Prompt scaffold {#prompt-scaffold}

```text
Draft an insight summary from this validated result. I'll edit it, so favor precision
and brevity over polish.

Decision it informs: <e.g. quarterly board deck narrative on growth trajectory>
Question answered: <restated question from the clarified spec>
Validated numbers: <aggregate results, e.g. committed MRR by month, trailing 12 months>
Source / definition / window: <e.g. Northwind Billing, committed MRR, monthly, TTM>
My confidence and why: <e.g. High -- reconciled to finance control number within $0>
Known caveats or assumptions: <e.g. excludes accounts added after the 25th of the month>
Recommended next action: <e.g. include in board deck as-is; flag Q3 dip for discussion>

Structure the draft with these fields, in this order:
- Headline answer -- one sentence, no hedging language buried in it
- Confidence (High / Medium / Low) with one concrete reason
- Key numbers -- the smallest set that supports the headline
- What it means for the decision
- Caveats & assumptions
- Method (source, definition, window)
- Next action
- Links / appendix -- placeholder for the saved query and validation checklist

Keep the headline answer to one sentence. Do not soften the confidence rating with
qualifiers that aren't in "Caveats & assumptions."
```

## After the model responds {#after-the-model-responds}

Check the headline against the actual numbers — models drift toward optimistic framing.
Confirm the confidence rating is yours, not the model's guess at how confident you
should sound. Fill in `templates/insight-summary-template.md` with the edited draft, add
the real link to the saved query or notebook, and route through peer review before it
reaches the stakeholder.
