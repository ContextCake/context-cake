---
title: Your first cascade
description: Resolve a concept across layers in five minutes.
---

Resolve a concept across layers in five minutes.

## Resolve the bundled demo

`playground/manifest.json` ships with a three-layer demo bundle — `personal`
(level 3), `team` (level 2), and `company` (level 0) — under
`playground/demo-layers/`. Resolve its most interesting concept:

```bash
node resolver.mjs --manifest playground/manifest.json --concept decisions/primary-db
```

You'll get back the effective, merged concept as JSON:

```json
{
  "id": "decisions/primary-db",
  "contributors": [
    { "layer": "personal", "level": 3, "updated": "2026-06-28" },
    { "layer": "team", "level": 2, "updated": "2026-06-20" },
    { "layer": "company", "level": 0, "updated": "2026-05-01" }
  ],
  "sections": [
    {
      "key": "choice",
      "heading": "## Choice {#choice}",
      "content": "Postgres in every shared environment. Locally I run SQLite...",
      "sourceLayer": "personal",
      "conflicts": [
        { "layer": "company", "updated": "2026-05-01", "content": "Postgres (org standard)..." }
      ]
    },
    {
      "key": "rationale",
      "heading": "## Rationale {#rationale}",
      "content": "Postgres for OLTP, yes — but we added ClickHouse for analytics...",
      "sourceLayer": "team",
      "conflicts": [
        { "layer": "company", "updated": "2026-05-01", "content": "One vendor, one backup story..." }
      ]
    },
    {
      "key": "ownership",
      "heading": "## Ownership {#ownership}",
      "content": "Platform team owns provisioning, upgrades, and the backup policy...",
      "sourceLayer": "company"
    }
  ]
}
```

Read it top to bottom:

- **`contributors`** — every layer that has a version of this concept, each with
  the date it was last updated. All three layers write `decisions/primary-db`
  here.
- **Per-section `sourceLayer`** — each section is resolved independently. The
  merge isn't whole-document replacement: `personal` wins `Choice`, `team` wins
  `Rationale`, and `Ownership` / `Related` fall through untouched to `company`
  because neither `personal` nor `team` speaks to them.
- **`conflicts`** — where a higher layer overrides a lower one on the *same*
  section, the lower layer's value doesn't disappear. `Choice` carries a
  `conflicts` entry showing `company`'s dissenting text ("Postgres (org
  standard)... No other primary datastore is approved for production") right
  alongside `personal`'s override. Same for `Rationale` against `team`. This is
  the "surfaced, not hidden" policy: an agent reading this concept sees not just
  the winning answer, but that there's organizational disagreement about it,
  and what each side said.

Sections with no conflict — `Ownership`, `Related`, the personal-only
`My notes` — just carry a single `sourceLayer` and nothing else.

:::tip
Open the same concept in the playground (`npm run playground`) to see this
same merge rendered visually — precedence chain, winning sections, and
conflict panels side by side.
:::

## Point it at your own layers

The demo bundle is fixed data for learning the shape. To resolve your own
knowledge, write a `layers.json` manifest naming your layers, each as an
`okf-local` source — a directory of markdown files with YAML frontmatter (the
only required field is `type`):

```json
{ "layers": [
  { "name": "team",    "level": 2, "path": "~/kb-team" },
  { "name": "company", "level": 0, "path": "~/kb-company" }
] }
```

`source` defaults to `okf-local` when omitted, so you don't need to write it
for local directories. Now create the same concept in both layers, with one
section in common:

```markdown
<!-- ~/kb-company/decisions/primary-db.md -->
---
type: decision
title: Primary database
updated: 2026-05-01
---

# Primary database

## Engine {#engine}

Postgres.

## Backups {#backups}

Nightly snapshots to cold storage.
```

```markdown
<!-- ~/kb-team/decisions/primary-db.md -->
---
type: decision
title: Primary database
updated: 2026-06-20
---

# Primary database

## Engine {#engine}

SingleStore (chosen for HTAP workloads).
```

Resolve it:

```bash
node resolver.mjs --manifest layers.json --concept decisions/primary-db
```

`team` is level 2, `company` is level 0, so `team` wins `Engine` — and because
`company` disagrees on that same section, its value rides along as a
`conflicts` entry. `Backups` isn't mentioned in `team`'s file at all, so it's
inherited from `company` untouched, with no conflict. Nothing is lost, and the
disagreement on `Engine` is visible to anyone (or any agent) reading the
resolved concept, not silently overwritten.

## Next

- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent) — expose this
  same resolved graph to Claude or any MCP client
- [Merge semantics](/docs/concepts/merge-semantics) — the full section/field
  merge and precedence rules
