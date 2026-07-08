# Issue Triage

Use labels to make issues clear enough for both human and AI contributors.

## Area Labels

- `area:core` — resolver, MCP server, source adapters, ingest, write, promote,
  core fixtures, and root compatibility wrappers.
- `area:console` — React console app under `apps/console`.
- `area:site` — Astro site and public docs under `apps/site`.
- `area:playground` — local playground, control surface, OKF browser, or demo
  surfaces.
- `area:docs` — repo docs, specs, examples, and contributor guidance.
- `area:packs` — ContextCake Packs specs, templates, or pack content.

## Type and Readiness Labels

- `type:bug` — broken or regressed behavior.
- `type:enhancement` — new behavior, cleanup, structure, or polish.
- `good first issue` — small change with obvious files and validation.
- `needs-spec` — cannot be safely implemented until a decision is made.
- `ai-ready` — clear enough for an AI contributor to attempt with tests.

## AI-Ready Checklist

An issue can be labeled `ai-ready` when it includes:

- the affected area and likely files;
- expected behavior and out-of-scope boundaries;
- commands or manual steps to validate;
- any compatibility requirement for root commands, deploy paths, or generated
  files.

Remove `ai-ready` if implementation requires product judgment, hidden access,
production credentials, or unresolved design choices.
