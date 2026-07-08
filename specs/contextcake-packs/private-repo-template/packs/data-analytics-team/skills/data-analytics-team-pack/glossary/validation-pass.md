---
type: glossary
updated: 2026-07-06
---

# Validation Pass {#validation-pass}

## Definition {#definition}

A validation pass is the checked, repeatable set of steps you run on a build to confirm
it matches the clarified spec and reconciles to the source of truth before it ships. It
is the output of the Validate phase — the gate between "the query ran" and "the number is
trustworthy."

## Why it matters {#why-it-matters}

A query that runs without error is not the same as a query that answers the right
question correctly. Wrong joins, double-counted rows, an off-by-one date boundary, or a
timezone mismatch all produce a number that looks plausible and is wrong. A validation
pass catches these before a stakeholder does — finding a discrepancy in review is a
non-event; finding it after the number is in a board deck is a credibility problem. It
also gives you a paper trail: when a number is challenged later, you can point to what was
checked rather than re-deriving trust from scratch.

## Running a validation pass {#running-a-validation-pass}

Work through `templates/validation-checklist-template.md` item by item — source of truth
identified, metric definition matches the agreed definition, grain correct, filters and
segments applied correctly, record counts reconcile, totals reconcile to a source-of-truth
control number, sample rows spot-checked, nulls and duplicates checked, date boundaries
and time zone correct, result is reproducible, peer reviewed. Don't skip items because the
build "looks right" — the checklist exists specifically to catch the errors that look
right. The full procedure, including what to do when reconciliation fails, is in
`workflows/build-and-validate.md`.

## Northwind example {#northwind-example}

For the VP of Sales's MRR build, the analyst runs the validation pass before sending
anything: confirms the query uses committed MRR (not recognized revenue), confirms the
billing system is the source queried, reconciles the trailing-twelve-month total to
finance's monthly-close number within rounding, spot-checks five accounts against the
billing UI directly, and confirms no duplicate subscription rows from a known join issue
with add-ons. Only after all items pass does the build move to the Deliver phase.

## See also {#see-also}

- `templates/validation-checklist-template.md`
- `workflows/build-and-validate.md`
- `glossary/source-of-truth.md`
