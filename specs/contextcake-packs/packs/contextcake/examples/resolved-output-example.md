---
type: example
updated: 2026-08-04
---

# What an agent gets back from `read_file` {#what-an-agent-gets-back}

This is the shape of a resolved concept — what `read_file` returns after
the resolver stitches every contributing layer together. It's the same
`decisions/primary-db` concept from `examples/okf-concept-example.md`,
resolved across a personal/team/company cascade. The response below is
real resolver output (`node resolver.mjs --manifest <manifest> --concept
decisions/primary-db`), trimmed to the two sections that show both shapes:
a contested section and a clean inherited one.

## The response {#the-response}

```json
{
  "id": "decisions/primary-db",
  "contributors": [
    { "layer": "personal", "level": 3, "updated": "2026-06-28" },
    { "layer": "team", "level": 2, "updated": "2026-06-20" },
    { "layer": "company", "level": 0, "updated": "2026-05-01" }
  ],
  "frontmatter": {
    "type": "decision",
    "title": "Primary database",
    "updated": "2026-06-28",
    "owner": "me",
    "tags": ["database", "local-dev"]
  },
  "frontmatterProvenance": {
    "type": "personal",
    "title": "personal",
    "updated": "personal",
    "owner": "personal",
    "tags": "personal"
  },
  "sections": [
    {
      "key": "rationale",
      "heading": "## Rationale {#rationale}",
      "content": "Postgres for OLTP, yes — but we added ClickHouse for analytics after the reporting\nqueries started locking the primary. The org \"one datastore\" line no longer matches\nwhat we actually run.",
      "sourceLayer": "team",
      "sourceUpdated": "2026-06-20",
      "conflicts": [
        {
          "layer": "company",
          "updated": "2026-05-01",
          "content": "One vendor, one backup story, one compliance boundary. Managed RDS is SOC2-covered\nand the security team already audits it."
        }
      ]
    },
    {
      "key": "ownership",
      "heading": "## Ownership {#ownership}",
      "content": "Platform team owns provisioning, upgrades, and the backup policy. File a ticket in\n`platform/infra` for a new instance.",
      "sourceLayer": "company",
      "sourceUpdated": "2026-05-01"
    }
  ]
}
```

## Reading each part {#reading-each-part}

**`id`** is the concept path, stable across every layer that defines it.

**`contributors`** lists every layer that has a version of this concept at
all — as `{layer, level, updated}` objects, ordered by precedence — including
layers that didn't win any section shown, so an agent can see the full set
of voices, their precedence, and how fresh each one is.

**`frontmatter` / `frontmatterProvenance`** — frontmatter is field-merged,
not replaced. Each key in `frontmatterProvenance` names the layer the final
value came from; here personal defined all five fields, so personal wins all
five, even though team and company also define this concept.

**`sections[].key` / `heading`** — `key` is the section's merge identity
across layers (the `{#anchor}` when one is authored); `heading` is the
winning layer's raw heading line. Merging is per section, not per document:
`rationale` was won by team (level 2), while `ownership` was inherited
straight from company (level 0) because no higher layer spoke to it. A
higher layer doesn't have to restate what it agrees with.

**`sections[].sourceLayer` / `sourceUpdated`** — provenance and freshness,
per section. `sourceUpdated` is the winning section's date, falling back to
its document's date.

**`sections[].conflicts`** — where a section has more than one layer's
version, the losing layers ride along here — layer, `updated` date, and
full content — instead of being discarded. The `rationale` section shows
company's dissenting take, dated `2026-05-01`, so the agent can weigh the
older company line against the newer team rationale. A section with no
disagreement, like `ownership`, omits `conflicts` entirely. When a dissent
is *newer* than the effective value (compared at day granularity), the
section also carries `fresherDissent: true` — not the case here, since
company's line predates the team's. Dissent that differs from the winner
only by formatting (trailing whitespace, bullet glyphs, blank-line runs) is
not disagreement and is dropped before any of this.

Over MCP, `read_file` returns this object plus a rendered `markdown` view
of the same content, where each dissent is quoted beneath the winning
section with its layer and date.

## Why this shape, not just plain text {#why-this-shape}

An agent reading only `content` per section gets a fluent, coherent answer.
An agent that also reads `sourceLayer` and `conflicts` can reason about
trust and staleness explicitly — "this is the team's current call, and it
overrides an older, more conservative company default" — instead of
silently inheriting whichever layer happened to answer first.

## Next {#next}

- `use-cases/personal-team-company-context.md` — the three-layer scenario
  this response is drawn from
- `examples/layers-json-example.md` — the manifest that produced this
  cascade
