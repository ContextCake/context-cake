---
type: example
updated: 2026-07-08
---

# A full OKF concept file {#a-full-okf-concept-file}

This is a realistic `okf-local` concept, as it would sit on disk at
`decisions/primary-db.md` inside a team bundle. It shows the two required
pieces of every OKF file: YAML frontmatter, and markdown sections anchored
with `{#anchor}`.

## The file {#the-file}

```markdown
---
type: decision
title: Primary database
updated: 2026-06-20
owner: Data
tags: [database, architecture, analytics]
---

##Primary database

##Rationale {#rationale}

Postgres for OLTP, yes — but we added ClickHouse for analytics after the
reporting queries started locking the primary. The org "one datastore" line
no longer matches what we actually run.

##Analytics store {#analytics-store}

ClickHouse, self-hosted on the data cluster. It is a read replica target,
never a source of truth. Nightly ETL loads from Postgres on a fixed
schedule.

##Related {#related}

See [[runbooks/analytics-etl-failure]] for what to do when the nightly load
breaks.
```

## Reading it apart {#reading-it-apart}

**Frontmatter.** Only `type` is required by OKF. Everything else here —
`title`, `updated`, `owner`, `tags` — is optional but worth setting:
`updated` in particular is the staleness signal the resolver surfaces when
another layer's version of this concept disagrees.

**The concept ID.** This file's ID is `decisions/primary-db` — its path
inside the bundle, minus `.md`. That ID is stable across layers: a Company
bundle and a Personal bundle can each hold their own
`decisions/primary-db.md`, and the resolver treats all three as one
concept.

**Sections.** Each `{#anchor}` is the unit a higher layer can address
individually. A team layer can override just `Rationale` without touching
`Analytics store`, and a company layer that never mentions either section
still contributes anything else it defines under this same concept ID —
inherited, not overwritten.

**Links.** `[[wikilink]]` syntax inside a section body points at another
concept ID. Outgoing links are preserved in the resolved output and exposed
through the `get_links` MCP tool.

## What's notably absent {#whats-notably-absent}

No `layer` field, no precedence number, no merge instructions anywhere in
this file. A concept file doesn't know or care which layer it lives in or
who wins — that's entirely a property of where the bundle sits in
`layers.json`. The same file format works identically in the personal,
team, or company bundle.

## Next {#next}

- `examples/layers-json-example.md` — where this bundle's `path` gets
  declared
- `examples/resolved-output-example.md` — what this file looks like after
  merging with a company-layer version of the same concept
