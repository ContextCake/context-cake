---
type: architecture
updated: 2026-07-08
---

# OKF format {#okf-format}

ContextCake speaks Open Knowledge Format (OKF) natively — concepts,
frontmatter, anchored sections, and the links between concepts. It is the one
shape every layer resolves into, whether it started as OKF or was translated
from something else entirely. See `architecture/federated-storage-and-sources.md`
for how a foreign `mcp` source gets translated into this shape at read time.

## Markdown plus frontmatter {#markdown-plus-frontmatter}

A concept is a single markdown file: YAML frontmatter, then a body of
anchored sections. The frontmatter block looks like:

```yaml
type: decision
title: Primary database
updated: 2026-06-20
owner: Data
tags: [database, architecture, analytics]
```

Below the frontmatter, the body carries a title line ("Primary database")
followed by anchored sections — a `Rationale` section (anchor `#rationale`)
saying "Postgres for OLTP, yes -- but we added ClickHouse for analytics
after the reporting queries started locking the primary," and an `Analytics
store` section (anchor `#analytics`) saying "ClickHouse, self-hosted on the
data cluster. It is a read replica target, never a source of truth."

The only **required** frontmatter field is `type`. Everything else —
`title`, `updated`, `owner`, `tags` — is optional, but `updated` is worth
setting: it is the staleness signal the resolver surfaces when layers
disagree (`architecture/conflicts-and-provenance.md`).

## Concept IDs are file paths {#concept-ids-are-file-paths}

A concept's ID is its file path within the bundle, relative to the bundle
root, with the `.md` extension removed. A file at:

```
kb-team/decisions/primary-db.md
```

has the concept ID `decisions/primary-db`. That ID is **stable across
layers** — Company, Team, and Personal can each hold their own
`decisions/primary-db.md`, at the same relative path within their own
bundle root, and the resolver stitches all three into one effective concept
also named `decisions/primary-db`. Layers don't need to coordinate on
anything except that shared relative path.

## Anchored sections {#anchored-sections}

Every heading that matters carries an explicit `{#anchor}`. The anchor, not
the heading text, is what the resolver merges on — it lets a higher layer
address exactly the section it wants to speak to, even if it phrases the
heading slightly differently, and it lets the tombstone syntax
(`{#anchor override=none}`) target one section precisely. See
`architecture/section-merge.md` for how anchors drive the merge.

## Links between concepts {#links-between-concepts}

OKF is a graph, not a pile of documents. A section body can link to another
concept with `[[wiki-style]]` references, or ordinary markdown links that
resolve to a concept path. For example, a `Related` section (anchor
`#related`) might contain the line: `See [[incident-response]] for the
on-call path when a database is degraded.`

Outgoing links are preserved in the stitched output and exposed through the
`get_links` MCP tool (`architecture/the-mcp-server.md`).

## Frontmatter and sections both merge {#frontmatter-and-sections-both-merge}

Frontmatter is field-merged the same way section bodies are: for each key,
the highest layer that sets it wins; unset keys are inherited. A concept's
`type` almost always comes from whichever layer first defined the concept,
since lower layers rarely leave `type` unset.

## Next {#next}

- `architecture/section-merge.md` — how anchored sections combine across
  layers
- `architecture/federated-storage-and-sources.md` — how a non-OKF `mcp`
  source gets mapped into this same shape
- `architecture/the-mcp-server.md` — how a resolved OKF concept reaches an
  agent
