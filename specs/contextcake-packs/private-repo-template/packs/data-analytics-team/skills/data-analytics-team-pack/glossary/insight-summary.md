---
type: glossary
updated: 2026-07-06
---

# Insight Summary {#insight-summary}

## Definition {#definition}

An insight summary is the delivered output of a request: a short, structured writeup
that leads with the answer and carries its own confidence level, caveats, and next action.
It is the output of the Deliver phase — what the stakeholder actually reads, as opposed to
the query or notebook behind it.

## Why it matters {#why-it-matters}

A validated number delivered as a raw table or a chart with no context forces the
stakeholder to infer the confidence, caveats, and implications themselves — and they will
usually infer the most convenient version, not the most accurate one. An insight summary
does that interpretation work once, explicitly, so the stakeholder can't accidentally
overstate what the data shows. It also makes the analyst's judgment visible and
reviewable: a stated "Medium confidence, because segment attribution changed mid-quarter"
is something a peer or the stakeholder can push back on; a bare number is not.

## Canonical fields {#canonical-fields}

Every insight summary uses the same field names: Headline answer · Confidence (High /
Medium / Low, plus one reason) · Key numbers · What it means for the decision · Caveats &
assumptions · Method (source, definition, window) · Next action · Links / appendix. Use
`templates/insight-summary-template.md` to fill these in. The **Confidence** and **Caveats**
fields are not optional padding — they're what separates an insight summary from a
dashboard screenshot, and they're what protects the stakeholder from over-reading a number
you know has soft spots.

## Northwind example {#northwind-example}

The MRR insight summary for the VP of Sales leads with: "MRR grew 4% over the trailing 12
months, driven by expansion revenue outpacing churn in the last two quarters." Confidence:
High, reconciled to billing system finance close. Caveats: one enterprise contract
renewal was delayed into next month and is not yet reflected. Next action: flag the
delayed renewal to the CFO before the board deck locks. The VP gets a decision-ready
answer, not a chart to interpret alone.

## See also {#see-also}

- `templates/insight-summary-template.md`
- `workflows/insight-delivery.md`
- `glossary/validation-pass.md`
