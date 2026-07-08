---
type: policy
updated: 2026-07-06
---

# PII and Access Boundaries {#pii-and-access-boundaries}

External AI tools (Claude, ChatGPT, Cursor, Copilot, and similar) are useful for
clarifying requests, designing validation checks, and drafting summaries — see
`prompt-guides/`. None of that requires pasting a single real customer row into any of
them. This policy sets the boundary between what's safe to share and what isn't.

## Never paste into an external AI tool {#never-paste}

- Raw customer or account rows, exports, or spreadsheet excerpts containing real data.
- Personally identifiable information: names, emails, phone numbers, addresses, or any
  other field that identifies a real individual.
- Account-level detail tied to a real, identifiable company or person, even a single row
  "just to check the format."
- Credentials, API keys, connection strings, or anything that grants access to a system.
- Full unredacted query results, even if the query itself is safe to share.

This applies whether the tool is a chat interface, an IDE assistant with file context,
or an agent with tool access — the boundary is about what leaves your environment, not
which interface it leaves through.

## Safe to share {#safe-to-share}

- **Schemas** — table and column names, types, relationships. No data.
- **Aggregate numbers** — totals, counts, percentages, rates (e.g. "1,842 accounts",
  "MRR grew 4.2% month over month"). Aggregates that could uniquely identify an
  individual (e.g. "the one enterprise account in the Northeast region") are not safe —
  treat small-n aggregates as if they were row-level data.
- **Query and model logic** — SQL, dbt models, notebook cells, transformation code.
- **Synthetic or fictional examples** — made-up companies and numbers built to illustrate
  a pattern, clearly not real data (this pack's own Northwind examples are the model).
- **Metric definitions, clarified specs, and validation checklists** — these describe
  method, not data.

## Respecting access boundaries and least privilege {#respecting-access-boundaries}

- Only query data your role has access to. A clarified spec that requires data outside
  your access is an escalation, not a workaround — route it to whoever holds that access
  rather than requesting broader permissions "to be efficient."
  See `templates/clarified-spec-template.md`'s **Owner** field for who to route through.
- Don't grant an AI tool or agent standing access to a production warehouse or customer
  database. If a tool needs live query access, scope it to a read-only, non-PII view or
  a synthetic/staging dataset — never point it directly at raw customer tables.
  See `tool-guides/using-with-claude-code.md` for connecting this pack to an assistant
  safely.
- When in doubt about whether a field counts as PII, treat it as PII. Ask the team's
  data owner rather than guessing.

## If PII already reached a tool {#if-pii-already-reached-a-tool}

Treat it as an incident, not a cleanup task: stop the conversation, notify your team's
data owner or manager immediately, and follow your company's data incident process. Do
not try to quietly delete the message and move on — the exposure already happened
regardless of whether the message is later removed.
