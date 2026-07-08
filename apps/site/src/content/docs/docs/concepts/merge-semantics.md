---
title: Merge semantics
description: Section and field merge — not whole-document replacement.
---

The resolver stitches every layer's version of a concept into one effective concept.
The merge is **section-level**, never whole-document replacement (except when a layer
explicitly asks for that — see the override table below). A higher layer speaks to the
sections it knows; every section it does not restate is inherited from below.

## Section merge

For each section (identified by its `{#anchor}`), the resolver picks a winner and
records where it came from:

- The **higher-level layer wins** that section. This is vertical precedence — decided
  by the layer's `level` in the [manifest](/docs/reference/manifest), not by dates or
  recency.
- Everything the winner does not define is **inherited** from a lower layer.
- Each resolved section carries `sourceLayer` and `sourceUpdated` so you can see which
  layer won it and when that layer last touched it.

Precedence is purely by level. There is no same-level tiebreak rule — in the default
stack every layer has a distinct level.

## Frontmatter merge

Frontmatter is field-merged, not replaced. For each key, the higher layer wins that
one field; keys only a lower layer defines are inherited. A `frontmatterProvenance`
map records which layer each final field came from.

## The override table

Two rules and one escape hatch cover every case:

| Syntax | Behavior |
|--------|----------|
| *(default)* | Section/field merge — higher layer wins per key |
| `override: full` in frontmatter | Whole-concept replacement; everything below is dropped |
| `{#anchor override=none}` | Null/tombstone — suppresses the inherited section. Retained as `suppressed: true` for audit. |

`override: full` is the one case where a layer replaces the whole concept rather than
merging section by section. `{#anchor override=none}` lets a higher layer *blank* an
inherited section it declares does not apply, without restating everything to negate
it — the suppressed section is kept as `suppressed: true` for audit but emits no
content and no conflicts. Renderers skip suppressed sections. Full syntax:
[override reference](/docs/reference/override-syntax).

## Walkthrough: `decisions/primary-db`

The bundled demo defines `decisions/primary-db` in all three layers, and they
deliberately disagree. Here is what each layer says:

```markdown
<!-- Personal (level 3), updated 2026-06-28 -->
## Choice {#choice}
Postgres in every shared environment. Locally I run SQLite for the test suite...

## My notes {#notes}
The ClickHouse ETL job is flaky on my branch...

<!-- Team (level 2), updated 2026-06-20 -->
## Rationale {#rationale}
Postgres for OLTP, yes — but we added ClickHouse for analytics...

## Analytics store {#analytics}
ClickHouse, self-hosted on the data cluster...

<!-- Company (level 0), updated 2026-05-01 -->
## Choice {#choice}
Postgres (org standard). All services provision managed RDS...

## Rationale {#rationale}
One vendor, one backup story, one compliance boundary...

## Ownership {#ownership}
Platform team owns provisioning, upgrades, and the backup policy...
```

Resolving with `node resolver.mjs --manifest apps/playground/manifest.json --concept
decisions/primary-db` merges them section by section:

| Section | Winner | Why |
|---------|--------|-----|
| `Choice` | **Personal** | Personal (3) outranks Company (0) on the same section |
| `My notes` | **Personal** | Only Personal defines it |
| `Rationale` | **Team** | Team (2) outranks Company (0) |
| `Analytics store` | **Team** | Only Team defines it |
| `Ownership` | **Company** | Only Company defines it — inherited, no higher layer speaks to it |

`Choice` came from Personal, `Rationale` from Team, and `Ownership` is inherited
straight from Company — no higher layer said anything about ownership. Frontmatter
resolves the same way: `title` and `updated` come from Personal (the highest
contributor), so `frontmatterProvenance` records `personal` for those fields.

Two of these sections had disagreements — Personal's `Choice` versus Company's, and
Team's `Rationale` versus Company's. The winning value is primary, but the losing
layer is not thrown away: it rides along as a
[conflict with its date](/docs/concepts/conflicts-and-provenance).

## Next

- [Conflicts & provenance](/docs/concepts/conflicts-and-provenance) — what the resolver attaches when layers disagree
- [Override syntax reference](/docs/reference/override-syntax) — `override: full` and `override=none` in detail
- [The layer cake](/docs/concepts/layer-cake) — where precedence comes from
