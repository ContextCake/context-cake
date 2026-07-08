---
type: policy
updated: 2026-07-06
---

# Source of Truth Precedence {#source-of-truth-precedence}

Every metric in a clarified spec needs exactly one named source of truth — the system
whose number governs when two systems disagree. This policy sets the default precedence
rules and the process for when no default applies. See `glossary/source-of-truth.md` for
the definition and `templates/clarified-spec-template.md` for where you record the
choice on each request.

## Default precedence by metric family {#default-precedence-by-metric-family}

These are illustrative defaults for a company like Northwind, not universal law — your
team should adopt and publish its own list, then keep it current in this file or your
local overlay. The pattern matters more than the specific systems:

- **Revenue and billing metrics** (MRR, ARR, churn dollars) — the billing system wins
  over the CRM. The CRM reflects sales-stage estimates and manual edits; the billing
  system reflects what was actually invoiced or scheduled.
- **Usage and product metrics** (active accounts, feature adoption, session counts) —
  product analytics wins over spreadsheets or manually maintained trackers. Spreadsheets
  drift from the underlying event stream the moment someone forgets to refresh them.
  Product analytics wins over the CRM.
- **Account and org metadata** (plan tier, industry, employee count) — the system of
  record for that entity wins (e.g. the CRM for sales-owned fields, the billing system
  for plan and contract terms).
- **Support and CS metrics** (ticket volume, NPS, renewal risk) — the CS platform wins
  over ad hoc notes or Slack threads.

When two candidate sources are both plausible for the same metric, prefer the system
closer to the originating transaction over the system that summarizes or re-enters it.

## How to record a chosen source of truth {#how-to-record-a-chosen-source-of-truth}

Write the system name into the **Source of truth** field of
`templates/clarified-spec-template.md` for that request — not just "billing" but the
specific system (e.g. "Northwind Billing", not "finance"). If the choice required a
judgment call rather than following the default list above, note the reasoning in
**Open questions** or an inline comment so the next analyst doesn't have to re-derive it.

## When no authoritative source exists {#when-no-authoritative-source-exists}

Sometimes no system is authoritative yet — a new metric, a one-off analysis, or two
systems that both have partial claims. In that case:

1. Say so explicitly in the clarified spec rather than picking one silently.
2. Propose a source of truth to the stakeholder and get their sign-off before building —
   this is a decision, not a default.
3. Flag the metric as provisional in the insight summary's **Caveats & assumptions**
   field until a durable source of truth is established.
4. If the metric will recur, propose adding it to this file's default list so future
   requests don't repeat the ad hoc decision.

## Why this matters {#why-this-matters}

Contested numbers usually trace back to two people building against two different
systems, not to a math error. Naming the source of truth before building — and keeping
the default list current — prevents the argument from happening in the stakeholder
meeting instead of before it.
