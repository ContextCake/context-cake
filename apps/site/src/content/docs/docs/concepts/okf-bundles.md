---
title: OKF bundles
description: A layer is a directory of OKF markdown — frontmatter plus anchored sections.
---

An `okf-local` layer is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle: a directory of markdown files with YAML frontmatter. It is the default
source type. A layer that omits `source` in the manifest is treated as `okf-local`.

## A layer in the manifest

The [manifest](/docs/reference/manifest) declares each layer, its level, and its
source:

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

An `okf-local` layer points at a `path` — the directory that holds the bundle. An
`mcp` layer is a [foreign knowledge graph](/docs/guides/foreign-mcp-sources) reached
over a stdio MCP server; its responses are translated into OKF at read time so it
stitches in alongside the local bundles. This page is about the `okf-local` shape.

## Concept IDs map to file paths

A concept's ID is its file path within the bundle, relative to the bundle root, with
the `.md` extension removed. A file at:

```
~/kb-team/decisions/primary-db.md
```

has the concept ID `decisions/primary-db`. That ID is stable across layers: the
Company, Team, and Personal bundles can each hold their own
`decisions/primary-db.md`, and the resolver stitches all three into the one effective
concept `decisions/primary-db`.

## The file shape

A concept is YAML frontmatter followed by markdown sections. Sections are anchored
with `{#anchor}` so a higher layer can address exactly the section it wants to speak
to.

```markdown
---
type: decision
title: Primary database
updated: 2026-06-20
owner: Data
tags: [database, architecture, analytics]
---

# Primary database

## Rationale {#rationale}

Postgres for OLTP, yes — but we added ClickHouse for analytics after the reporting
queries started locking the primary.

## Analytics store {#analytics}

ClickHouse, self-hosted on the data cluster. It is a read replica target, never a
source of truth. Nightly ETL loads from Postgres.
```

The only **required** frontmatter field is `type`. Everything else — `title`,
`updated`, `owner`, `tags` — is optional. The `updated` date is worth setting: it is
the [staleness signal](/docs/concepts/conflicts-and-provenance) the resolver surfaces
when layers disagree.

Frontmatter is field-merged across layers (higher layer wins per field), and section
bodies are merged per anchor. The mechanics are covered in
[merge semantics](/docs/concepts/merge-semantics).

## Links between concepts

OKF is a graph, not a pile of documents. A section body can link to another concept
with `[[wiki-style]]` references:

```markdown
## Related {#related}

See [[incident-response]] for the on-call path when a database is degraded.
```

Outgoing links are preserved in the stitched output and exposed through the
[`get_links` MCP tool](/docs/reference/mcp-tools).

## Next

- [The layer cake](/docs/concepts/layer-cake) — how bundles stack into a cascade
- [Merge semantics](/docs/concepts/merge-semantics) — how bundles resolve into one concept
- [Manifest reference](/docs/reference/manifest) — every layer field
