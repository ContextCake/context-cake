---
type: example
updated: 2026-07-08
---

# What an agent gets back from `read_file` {#what-an-agent-gets-back}

This is the shape of a resolved concept — what `read_file` returns after
the resolver stitches every contributing layer together. It's the same
`decisions/primary-db` concept from `examples/okf-concept-example.md`, now
merged with a company-layer version that disagrees on one section.

## The response {#the-response}

```json
{
  "id": "decisions/primary-db",
  "frontmatter": {
    "type": "decision",
    "title": "Primary database",
    "updated": "2026-06-20",
    "owner": "Data"
  },
  "frontmatterProvenance": {
    "type": "team",
    "title": "team",
    "updated": "team",
    "owner": "team"
  },
  "contributors": ["team", "company"],
  "sections": [
    {
      "anchor": "rationale",
      "sourceLayer": "team",
      "sourceUpdated": "2026-06-20",
      "content": "Postgres for OLTP, yes -- but we added ClickHouse for analytics after the reporting queries started locking the primary.",
      "conflicts": [
        {
          "layer": "company",
          "updated": "2026-05-01",
          "content": "One vendor, one backup story, one compliance boundary. All services provision managed RDS by default."
        }
      ]
    },
    {
      "anchor": "ownership",
      "sourceLayer": "company",
      "sourceUpdated": "2026-05-01",
      "content": "Platform team owns provisioning, upgrades, and the backup policy.",
      "conflicts": []
    }
  ]
}
```

## Reading each part {#reading-each-part}

**`id`** is the concept path, stable across every layer that defines it.

**`frontmatter` / `frontmatterProvenance`** — frontmatter is field-merged,
not replaced. Each key in `frontmatterProvenance` names the layer that
final value came from; here team defined all four fields, so team wins all
four, even though company also defines this concept.

**`contributors`** lists every layer that has a version of this concept at
all — including ones that didn't win any section, so an agent can see the
full set of voices even when only some of them come through as primary
content.

**`sections[].sourceLayer` / `sourceUpdated`** — per section, not per
document. `rationale` was won by team (level 2); `ownership` was inherited
straight from company (level 0) because no higher layer spoke to it. This
is the section-merge model: a higher layer doesn't have to restate what it
agrees with.

**`sections[].conflicts`** — where a section has more than one layer's
version, the losing layers ride along here instead of being discarded. The
`rationale` section shows company's dissenting take, dated `2026-05-01`, so
the agent can decide for itself whether the older company line or the newer
team rationale is more relevant to the question being asked. A section with
no disagreement, like `ownership`, has an empty `conflicts` array.

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
