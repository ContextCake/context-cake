---
type: overview
updated: 2026-07-06
---

# Pack Purpose {#pack-purpose}

## What this pack is {#what-this-pack-is}

This pack is operating knowledge for small data and analytics teams: a shared way to
take a stakeholder request from a vague Slack message to a validated, delivered answer.
It is not a course and not a style guide. It is the checklist, vocabulary, and templates
your team actually uses on every request, written down once so you stop reinventing them.

## Who it's for {#who-its-for}

Small in-house data and analytics teams, roughly 2-8 people: report builders, SQL
analysts, analytics engineers, PM-adjacent analysts, CS-ops partners, and the technical
manager who owns the queue. If your team fields recurring "can you pull..." and "why did
this number move..." requests from stakeholders who are not themselves analysts, this
pack is for you.

## The one problem it solves {#the-one-problem-it-solves}

Small analytics teams answer the same shape of request over and over: a stakeholder
asks an ambiguous question, someone builds something fast, the number gets challenged in
a meeting, and nobody can reconstruct why it doesn't match what finance or the CRM shows.
The team loses trust one contested number at a time.

This pack fixes the recurring failure points with a repeatable path: scope the request
before building (`workflows/request-clarification.md`), validate every build against a
named source of truth before it ships (`workflows/build-and-validate.md`), and deliver
answers in a format that carries its own confidence and caveats
(`workflows/insight-delivery.md`). The full path is documented end to end in
`workflows/stakeholder-request-to-insight.md`.

## A short tour {#a-short-tour}

- `overview/` — this file and `overview/team-shapes.md`, on where this pack fits your team's shape.
- `glossary/` — shared vocabulary: source of truth, stakeholder request, clarified spec,
  metric definitions, validation pass, insight summary. Read these once so the rest of
  the pack reads as plain English.
- `workflows/` — the four-phase hero workflow: clarify, build, validate, deliver.
- `templates/` — the clarified-spec, validation-checklist, and insight-summary templates
  you fill in on every request.
- `policies-and-rules/` — precedence rules for source of truth and metric change control,
  for when two systems disagree or a definition changes underneath you.
- `prompt-guides/` — prompts for using this pack with an AI assistant during clarification.
- `examples/` — a worked example (an MRR trend request) that ties the whole pack together.
- `tool-guides/` — how to use this pack with Claude Code specifically.

## How to use it {#how-to-use-it}

Three equivalent ways to consume this pack, pick whichever fits your setup:

- **Plain files.** Read the markdown directly, top to bottom, starting with
  `START-HERE.md`. No tooling required.
- **Claude Code plugin.** Install the pack so `SKILL.md` and its linked files are
  available to Claude Code as project context. See `tool-guides/using-with-claude-code.md`.
- **OKF-compatible bundle.** Every content file carries OKF frontmatter (`type`,
  `updated`) and anchored headings, so the pack can be read as a layer by ContextCake's
  resolver alongside your team's own context layers.

## What this is not {#what-this-is-not}

- **Not a BI tool.** It doesn't build dashboards or run queries. It's the process and
  vocabulary around the query.
- **Not a warehouse connector.** There's no integration with your database, dbt project,
  or notebook environment. You bring your own stack.
- **Not a live-metrics service.** Nothing here refreshes automatically or holds current
  numbers. Every example is illustrative and static; the pack teaches the method, not the
  metric values.

## See also {#see-also}

- `overview/team-shapes.md`
- `workflows/stakeholder-request-to-insight.md`
- `glossary/source-of-truth.md`
