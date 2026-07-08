---
type: tool-guide
updated: 2026-07-06
---

# Using with Cursor {#using-with-cursor}

Cursor's assistant reads whatever is in your repo, so the fastest path is to check the
pack in as docs the assistant can pick up on its own — no separate upload step.

## Drop the pack into the repo {#drop-the-pack-into-the-repo}

Copy the pack directory into your project, typically under `docs/` so it reads clearly
as reference material rather than application code:

```bash
mkdir -p docs/data-analytics-team-pack
cp -R data-analytics-team-pack/* docs/data-analytics-team-pack/
```

If your team uses Cursor's project rules (`.cursor/rules/`), add a short rule that points
at the pack instead of duplicating its content:

```text
When helping with a stakeholder data request, follow the workflow in
docs/data-analytics-team-pack/workflows/stakeholder-request-to-insight.md and use the
templates in docs/data-analytics-team-pack/templates/.
```

This keeps the pack as the single source of truth for the workflow — the rule just tells
Cursor where to look.

## Reference files in-chat {#reference-files-in-chat}

Inside a Cursor chat, `@`-mention the file you want the assistant to read before it
answers:

```text
@docs/data-analytics-team-pack/templates/clarified-spec-template.md
Help me fill this in for a stakeholder request about MRR trending.
```

```text
@docs/data-analytics-team-pack/templates/validation-checklist-template.md
Check my query against this before I hand it off.
```

`@`-mentioning pulls the file into context explicitly, which matters for a pack like this
one — Cursor's implicit repo indexing is tuned for code, not for surfacing a markdown
template at the right moment.

## Your first task {#your-first-task}

Confirm the drop-in worked by clarifying the canonical example request. In a Cursor chat:

```text
@docs/data-analytics-team-pack/workflows/request-clarification.md
@docs/data-analytics-team-pack/templates/clarified-spec-template.md
A stakeholder asked "How is MRR trending?" Walk me through clarifying this request using
the linked workflow and template.
```

Expect Cursor to walk the clarified-spec fields — metric definition, source of truth,
grain, segments, time window, acceptance criteria — before proposing any SQL. If it
proposes a query first, the files weren't in context; re-mention them explicitly.

## See also {#see-also}

- `../workflows/request-clarification.md`
- `../templates/clarified-spec-template.md`
- `../updates/MERGE-GUIDE.md`
