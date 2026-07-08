# Start Here

This pack helps a small data or analytics team turn repeat stakeholder requests into
clarified specs, validated builds, and insight summaries stakeholders actually trust. It
is a set of plain-text workflows, templates, and reference docs, not a tool. You can use
it standalone, as a Claude Code plugin, or loaded into ChatGPT, Cursor, or Copilot.

## Reading order {#reading-order}

Read these in order the first time through — each one assumes you've read the ones
before it:

1. `overview/pack-purpose.md` — what this pack is, who it's for, and the one problem it
   solves. Two minutes.
2. `workflows/stakeholder-request-to-insight.md` — the hero workflow: clarify, build,
   validate, deliver. This is the spine of the whole pack.
3. `templates/clarified-spec-template.md` — the template you fill in during the Clarify
   phase, before you build anything.
4. `templates/validation-checklist-template.md` — the checklist you run during the
   Validate phase, before you deliver anything.
5. `templates/insight-summary-template.md` — the template you fill in during the Deliver
   phase, instead of sending a raw number or an unannotated dashboard link.
6. `examples/worked-example-mrr-request.md` — a full worked example (Northwind's VP of
   Sales asking "How is MRR trending?") that shows all three templates filled in end to
   end, so you can see the shape of a real request before you run your own.
7. Whichever file in `tool-guides/` matches your setup —
   `tool-guides/using-with-claude-code.md`, `tool-guides/using-with-chatgpt.md`,
   `tool-guides/using-with-cursor.md`, or `tool-guides/using-with-copilot.md` — for how to
   point your assistant at this pack.

After that, `glossary/` and `policies-and-rules/` are reference material — dip into them
when a specific term or precedence question comes up rather than reading them straight
through. `SKILL.md` is a routing index if you're working with an AI assistant and want it
to jump straight to the right file for a given task.

## Local overrides {#local-overrides}

Do not edit the installed pack files directly. If your team needs a local exception — a
different source-of-truth system, a house style tweak, an extra template field — put it
in your own project or team context, outside this pack, so future pack updates can be
compared and merged without clobbering your changes. See `local-overlay/README.md` for
the pattern and `updates/MERGE-GUIDE.md` for how to apply updates without losing local
edits.

## Starting cold {#starting-cold}

If you only read one file besides this one, read
`workflows/stakeholder-request-to-insight.md` — it tells you what to do with a real
request and links out to everything else on demand. You do not need a live walkthrough or
anyone else on the team to get started: pick a real (or the worked example's) stakeholder
request, open `templates/clarified-spec-template.md`, and start filling it in.
