---
type: workflow
updated: 2026-07-06
---

# Insight Delivery {#insight-delivery}

Phase 4 of `workflows/stakeholder-request-to-insight.md`. Input: a validated result plus
completed `templates/validation-checklist-template.md`. Output: a filled
`templates/insight-summary-template.md` delivered to the stakeholder.

## Why a summary, not a screenshot {#why-a-summary-not-a-screenshot}

A dashboard screenshot or an unannotated link makes the stakeholder do the interpretation
work — and they'll do it without your context on caveats, definitions, or confidence. An
insight summary does the interpretation for them, states what's uncertain, and tells them
what to do next. That's the deliverable, not the query.

## Filling the summary {#filling-the-summary}

Use `templates/insight-summary-template.md` and cover every field:

- **Headline answer:** one sentence, in plain language, that answers the question restated
  in the clarified spec. "Committed MRR grew 4% month-over-month, driven by expansion" —
  not "here's the MRR data."
- **Confidence (High / Medium / Low + one reason):** state it explicitly. High means the
  validation checklist passed clean with no exceptions. Medium means it passed with a
  documented exception (for example, one system was a day stale). Low means you're
  delivering provisional numbers under time pressure — say so, don't hide it.
- **Key numbers:** the 3-5 numbers that matter, at the grain the stakeholder asked for. Not
  a full data dump.
- **What it means for the decision:** tie back to the "decision it informs" field from the
  clarified spec. If the board deck needs a growth narrative, say whether this number
  supports or complicates that narrative.
- **Caveats & assumptions:** anything a careful reader needs to know before repeating this
  number elsewhere — a normalization convention, an excluded segment, a known data gap.
- **Method (source · definition · window):** the three things most likely to make this
  number disagree with someone else's version of "MRR." Stating them prevents duplicate
  work and definition drift later.
- **Next action:** what should the stakeholder do with this? Approve a number for the
  deck, flag a segment for follow-up, decide nothing yet pending more data. A summary
  without a next action leaves the stakeholder guessing what you want from them.
- **Links / appendix:** the saved query, the validation checklist, and any supporting
  detail — kept out of the main summary so the headline stays readable.

## Stating confidence and caveats without hedging into uselessness {#stating-confidence-and-caveats}

State confidence and caveats plainly, but don't bury the answer under qualifications. One
confidence line and a short caveats list is enough. If you find yourself writing five
caveats, that's a signal the build or validation wasn't finished — go back to
`workflows/build-and-validate.md` rather than shipping a heavily caveated answer.

## Giving a next action {#giving-a-next-action}

Every summary ends with what happens next, addressed to a specific person where possible:
"VP of Sales: confirm this figure for the Q3 board deck by Thursday" beats "let me know if
you have questions." A next action turns a report into a decision point.

## Output {#output}

A filled `templates/insight-summary-template.md`, sent to the stakeholder named as owner in
the clarified spec, with the validation checklist linked as backup — not the primary
artifact.
