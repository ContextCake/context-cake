---
type: template
updated: 2026-07-06
---

# Insight Summary Template {#insight-summary-template}

## How to use this {#how-to-use-this}

Copy this file when you deliver a validated build to a stakeholder. Complete
`templates/validation-checklist-template.md` first — an insight summary reports on a
validated result, it does not replace validation. See `workflows/insight-delivery.md`
for the full deliver phase.

## Headline answer {#headline-answer}

The answer, in one sentence, before any supporting detail. Lead with this — a stakeholder
who reads nothing else should still get the answer.

_[e.g., "Committed MRR grew 4.2% month-over-month in June, driven by expansion revenue."]_

## Confidence {#confidence}

High / Medium / Low, plus one reason. Low confidence is a valid answer — say so rather
than hiding it behind precision the data doesn't support.

_[e.g., High — reconciled to the billing system's finance-blessed number within $0]_

## Key numbers {#key-numbers}

The 3-5 numbers that support the headline answer. Include the comparison point (prior
period, target, etc.), not just the raw figure.

_[e.g., June committed MRR: $1.42M (May: $1.36M); expansion: +$61K; churn: -$18K]_

## What it means for the decision {#what-it-means-for-the-decision}

Connect the numbers back to the decision from the clarified spec's "Decision it informs"
field. Do not make the reader do this translation themselves.

_[e.g., growth is expansion-led, not new-logo-led — relevant for the board narrative on pipeline health]_

## Caveats & assumptions {#caveats-assumptions}

Anything that could change the answer, or that a careful reader would ask about.

_[e.g., excludes accounts added after the 25th of the month due to billing system lag]_

## Method {#method}

Source, definition, and window, restated briefly so the summary stands alone.

_[e.g., source: Northwind Billing; definition: committed MRR; window: trailing 12 months, closed May]_

## Next action {#next-action}

What should happen next, and who owns it. An insight summary without a next action is
just a report.

_[e.g., include in Friday's board deck prep; flag expansion trend to CS-ops for renewal outreach]_

## Links / appendix {#links-appendix}

Links to the saved query/notebook, the validation checklist, and any supporting charts.

_[e.g., query: `queries/mrr-trend-2026-06.sql`; checklist: `validation/2026-06-mrr.md`]_
