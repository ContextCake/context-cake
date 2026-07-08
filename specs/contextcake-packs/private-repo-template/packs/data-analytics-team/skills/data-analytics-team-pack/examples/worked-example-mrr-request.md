---
type: example
updated: 2026-07-06
---

# Worked Example: MRR Request {#worked-example-mrr-request}

A full pass through the hero workflow (`workflows/stakeholder-request-to-insight.md`),
start to finish, on the request every analytics team gets sooner or later: "how's MRR
doing?" Fictional company, fictional numbers — Northwind, a B2B SaaS.

## The request {#the-request}

Slack message from Northwind's VP of Sales, Thursday afternoon:

> "Hey — can someone pull our MRR trend for the board deck? Need it by Monday."

Six words of metric, zero words of definition. This is the default shape of a
stakeholder request — see `glossary/stakeholder-request.md`. Don't build yet.

## Phase 1: Clarify {#phase-1-clarify}

The analyst runs the request through `workflows/request-clarification.md` and comes
back with a clarified spec, using `templates/clarified-spec-template.md` and the
prompts in `prompt-guides/clarifying-a-stakeholder-request.md`:

**Request (verbatim):** "Can someone pull our MRR trend for the board deck? Need it by
Monday."
**Decision it informs:** Quarterly board deck — investor-facing narrative on revenue
momentum.
**Question (restated):** How has recognized monthly recurring revenue trended over the
trailing 12 months, broken out by new, expansion, contraction, and churn?
**Metric definition(s):** Recognized MRR (billing-system definition), not committed or
booked MRR. See `glossary/metric-definitions.md` for why this distinction matters.
**Source of truth:** The billing system (Northwind's subscription ledger), not the CRM.
The CRM tracks pipeline and bookings, not recognized revenue — see
`policies-and-rules/source-of-truth-precedence.md`.
**Grain:** Monthly.
**Filters / segments:** New, expansion, contraction, churn. Excludes one-time services
revenue.
**Time window:** Trailing 12 months, ending last closed month.
**Acceptance criteria:** Monthly totals reconcile to the billing system's finance-blessed
MRR number within rounding; segment breakout sums to the total.
**Deadline:** Monday, 9am, ahead of Tuesday's board prep review.
**Owner:** VP of Sales (requester); Finance is a stakeholder on the number.
**Open questions:** None outstanding — confirmed recognized (not committed) MRR with the
VP of Sales directly.

## Phase 2: Build {#phase-2-build}

The analyst builds against the billing system's subscription ledger per
`workflows/build-and-validate.md`: one query per month in the window, summing active
subscription value at month-end, split into the four segments by comparing each
account's current-month value to its prior-month value (new = no prior value,
expansion/contraction = value changed, churn = value dropped to zero). Query and output
saved to the team's shared notebook location so the result is reproducible.

## Phase 3: Validate {#phase-3-validate}

Run through `templates/validation-checklist-template.md`:

- Source of truth identified — billing system ledger, confirmed with Finance.
- Metric definition matches the agreed definition — recognized MRR, confirmed.
- Grain correct — monthly, confirmed.
- Filters/segments applied correctly — spot-checked five accounts against each segment
  bucket by hand.
- Record counts reconcile — subscription row count matches billing system's active count
  for the current month.
- Totals reconcile to a source-of-truth control number — Finance's month-end MRR figure
  for the most recent closed month is a **synthetic control value of $1,842,000**. The
  query's independently computed total for that month is $1,839,500, a $2,500 (0.14%)
  gap — inside the team's agreed 0.5% reconciliation tolerance.
- Sample rows spot-checked — five accounts traced end to end from ledger row to segment
  bucket.
- Nulls & duplicates checked — no null subscription values in the window; no duplicate
  account-month rows.
- Date boundaries / time zone correct — month-end cutoff aligned to billing system's
  close calendar (UTC), not calendar month-end.
- Result is reproducible — query saved to the shared notebook location referenced above.
- Peer reviewed — a second analyst re-ran the query and confirmed the same total.

Validation passes (`glossary/validation-pass.md`) at a $2,500 gap on a $1.84M total —
well inside tolerance and explained by two subscriptions that renewed mid-day on the
boundary date.

## Phase 4: Deliver {#phase-4-deliver}

Insight summary, per `workflows/insight-delivery.md` and
`templates/insight-summary-template.md`:

**Headline answer:** Recognized MRR grew 18% over the trailing 12 months, driven mainly
by expansion revenue from existing accounts.
**Confidence:** High — reconciled to the billing system's finance-blessed control number
within 0.14%, well inside tolerance.
**Key numbers:** Trailing-12-month MRR grew from $1.56M to $1.84M. Expansion contributed
$210K of the $280K net gain; new business contributed $140K; contraction and churn
offset $70K.
**What it means for the decision:** The board narrative can lean on expansion as the
primary growth engine, not new-logo acquisition — worth flagging if the deck currently
implies otherwise.
**Caveats & assumptions:** Recognized MRR, not committed/booked. Segment classification
uses month-over-month account value comparison, not a stamped event log — mid-month
plan changes are attributed to the month they took effect in the ledger.
**Method:** Source — billing system ledger. Definition — recognized MRR. Window —
trailing 12 months, monthly grain.
**Next action:** Hand off to VP of Sales for board deck integration; Finance cc'd for
awareness given the number appears in investor materials.
**Links / appendix:** Saved query location noted in the team's shared notebook; this
worked example for future MRR requests.
