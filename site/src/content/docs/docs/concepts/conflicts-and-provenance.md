---
title: Conflicts & provenance
description: Where layers disagree, the dissent rides along with dates — surfaced, not hidden.
---

ContextCake returns one primary answer per concept and is honest about dissent. Where
layers disagree on a section, the higher layer's value is primary and the dissenting
layers ride along as `conflicts` — each tagged with its layer and its last-updated
date. The contradiction is **surfaced, not hidden**.

## What a resolved concept carries

A `read_file` response resolves the whole concept and attaches provenance at three
levels:

- **`contributors`** — every layer that defines this concept, each as `{ layer, level,
  updated }`.
- **`frontmatterProvenance`** — for each frontmatter field, which layer the final value
  came from.
- **`sections[]`** — each section carries `{ key, heading, content, sourceLayer,
  sourceUpdated }`, plus an optional `conflicts[]` and an optional `suppressed: true`.

`sourceLayer` tells an agent which layer won a section; `frontmatterProvenance` does
the same per field. Together they let an agent weight facts by trust level — knowing a
section came from the Company layer versus a Personal draft.

## Conflicts ride along with dates

When another contributor defines a section with content that differs from the winner,
that dissent is attached as:

```json
"conflicts": [
  { "layer": "company", "updated": "2026-05-01", "content": "..." }
]
```

Sections where layers agree, or that only one layer defines, resolve silently — no
`conflicts` array. That is the common, non-contentious case. Suppressed
([tombstoned](/docs/reference/override-syntax)) sections emit no conflicts either: the
suppression *is* the answer.

The `updated` date on each conflict is the staleness signal. If a lower layer's
dissenting version is newer than the winning section, you simply see it and judge —
there is no separate drift-detection subsystem to consult.

## A real conflict: `decisions/primary-db`

In the bundled demo, the Personal layer wins the `Choice` section, but the Company
layer disagrees. The resolved section looks like this:

```json
{
  "key": "choice",
  "heading": "## Choice {#choice}",
  "content": "Postgres in every shared environment. Locally I run SQLite for the test suite so I\ncan reset state per-run without a container. Never commit SQLite-only assumptions.",
  "sourceLayer": "personal",
  "sourceUpdated": "2026-06-28",
  "conflicts": [
    {
      "layer": "company",
      "updated": "2026-05-01",
      "content": "Postgres (org standard). All services provision managed RDS through the platform\ncatalog. No other primary datastore is approved for production."
    }
  ]
}
```

The primary answer is Personal's nuanced take — Postgres in shared environments,
SQLite locally for the test suite. But the Company layer's stricter line — Postgres
via managed RDS only, no other primary datastore approved for production — is not
discarded. It rides along with its date (`2026-05-01`), so an agent reading this knows
the personal note diverges from org standard and can weight accordingly.

The concept's `contributors` and `frontmatterProvenance` for this resolution:

```json
"contributors": [
  { "layer": "personal", "level": 3, "updated": "2026-06-28" },
  { "layer": "team",     "level": 2, "updated": "2026-06-20" },
  { "layer": "company",  "level": 0, "updated": "2026-05-01" }
],
"frontmatterProvenance": {
  "type": "personal", "title": "personal", "updated": "personal",
  "owner": "personal", "tags": "personal"
}
```

## Surfaced, not hidden

This is the core philosophy. ContextCake never silently picks a winner and drops the
rest. It gives a clean primary answer up top and puts the dissent, its source, and its
date underneath. Nothing is hidden; you always see what the other layers said and when
they last said it.

## Next

- [Merge semantics](/docs/concepts/merge-semantics) — how the winner is chosen
- [MCP tools](/docs/reference/mcp-tools) — the `read_file` response an agent sees
- [The layer cake](/docs/concepts/layer-cake) — the layers a conflict spans
