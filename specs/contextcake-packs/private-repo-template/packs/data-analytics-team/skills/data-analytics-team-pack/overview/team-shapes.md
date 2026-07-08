---
type: overview
updated: 2026-07-06
---

# Team Shapes {#team-shapes}

Small data and analytics teams tend to fall into a handful of recognizable shapes. This
pack works for all of them, but the friction it removes shows up differently in each one.
Use this to see where your team sits and which parts of the pack to lean on first.

## The solo analyst {#the-solo-analyst}

One person, every request. No peer to sanity-check a query before it goes out, and no
shared memory beyond whatever is in that person's head or old Slack threads. The biggest
risk is silent scope drift: the stakeholder's question quietly changes between the ask
and the delivery, and there's no one else to catch it.

This pack helps most here as an external memory: the clarified-spec template
(`templates/clarified-spec-template.md`) replaces the analyst's head as the record of
what was actually asked, and the validation checklist
(`templates/validation-checklist-template.md`) stands in for a peer reviewer when there
isn't one.

## The 2-3 person report team {#the-2-3-person-report-team}

A small team splitting recurring report and ad hoc request work. The main failure mode is
inconsistency: two analysts answer similar questions with different metric definitions or
different validation rigor, and stakeholders notice the numbers don't line up.

This pack helps by making the definitions shared rather than personal —
`glossary/metric-definitions.md` and `policies-and-rules/source-of-truth-precedence.md`
apply the same way regardless of who picks up the request. Use
`workflows/build-and-validate.md` as the common bar every teammate's build clears before
delivery.

## The analytics-engineering pod {#the-analytics-engineering-pod}

A team that owns models and pipelines as well as ad hoc requests, usually with a dbt-style
project and a stronger notion of "the warehouse is the source of truth." The risk here is
inward focus: the team optimizes the model layer but under-invests in how a request enters
the queue and how an answer leaves it, so stakeholders still get inconsistent framing even
when the underlying numbers are solid.

This pack helps by bracketing the engineering work with the same clarify-and-deliver
discipline: `workflows/request-clarification.md` scopes what a model change is actually
for, and `workflows/insight-delivery.md` makes sure a technically correct number still
lands as a usable answer.

## The PM-embedded analyst {#the-pm-embedded-analyst}

An analyst embedded in a product or growth team, reporting into a PM rather than a central
data org. Requests arrive fast and informally, often mid-meeting, and there is pressure to
answer immediately rather than scope first. The risk is that "fast" quietly becomes
"unvalidated," and a number said out loud in a meeting becomes the de facto truth before
anyone reconciles it.

This pack helps by making clarification cheap enough to do even under time pressure — the
clarified-spec fields in `templates/clarified-spec-template.md` fit in a few lines — and
by giving the analyst a fast validation pass
(`glossary/validation-pass.md`) to run before a number leaves the room.

## See also {#see-also}

- `overview/pack-purpose.md`
- `workflows/stakeholder-request-to-insight.md`
- `glossary/validation-pass.md`
