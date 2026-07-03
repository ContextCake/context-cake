---
title: Override syntax
description: "Default section merge, override: full, and anchor-level tombstones."
---

By default the resolver merges concepts per section: a higher layer wins the
sections it speaks to, and everything else is inherited from below. Two pieces of
syntax let a layer override that default — one that replaces the whole concept, and
one that suppresses a single inherited section.

| Syntax | Behavior |
|--------|----------|
| *(default)* | Section/field merge — higher layer wins per key |
| `override: full` in frontmatter | Whole-concept replacement; everything below is dropped |
| `{#anchor override=none}` | Null/tombstone — suppresses the inherited section. Retained as `suppressed: true` for audit. |

## Default: section merge

With no override syntax, each section (by heading) and each frontmatter field is won
by the highest-precedence layer that defines it; the rest are inherited. A layer only
needs to speak to what it wants to change.

```markdown
<!-- company layer: decisions/primary-db.md -->
---
type: decision
---

## Decision {#decision}

Use Postgres 14.

## Rollback {#rollback}

Restore from the nightly snapshot.
```

```markdown
<!-- team layer: decisions/primary-db.md -->
---
type: decision
---

## Decision {#decision}

Use Postgres 16 with read replicas.
```

The team layer (level 2) wins `#decision`; the company layer's `#rollback` is
inherited unchanged. The effective concept has both sections, and the `#decision`
section carries a `conflicts` entry recording the company layer's dissenting value.
See [Merge semantics](/docs/concepts/merge-semantics).

## override: full

Set `override: full` in a layer's frontmatter to replace the entire concept. Every
contributor below that layer in the stack is dropped — no section merge, no inherited
sections, no conflicts from lower layers.

```markdown
<!-- personal layer: decisions/primary-db.md -->
---
type: decision
override: full
---

## Decision {#decision}

Local experiment: SQLite. Do not promote.
```

The resolved concept is exactly this file. The team and company layers below it are
discarded for this concept. Use it sparingly — it opts out of inheritance entirely.

## Anchor tombstone: `{#anchor override=none}`

To suppress a single inherited section without replacing the whole concept, define
that section in a higher layer with `override=none` on its anchor. This is a
tombstone: the section is hidden from the effective concept, but retained in the
resolved output as `suppressed: true` so the suppression is auditable.

```markdown
<!-- team layer: decisions/primary-db.md -->
---
type: decision
---

## Rollback {#rollback override=none}
```

The company layer's `#rollback` section no longer appears in the effective body. In
the resolved output the section is present but marked:

```json
{
  "key": "rollback",
  "heading": "## Rollback {#rollback}",
  "content": "",
  "sourceLayer": "team",
  "sourceUpdated": "2026-01-22",
  "suppressed": true
}
```

A suppressed section emits no `conflicts` — the tombstone *is* the answer. See
[Conflicts and provenance](/docs/concepts/conflicts-and-provenance) for how
`suppressed` and `conflicts` appear in a `read_file` response.

## Related

- [Merge semantics](/docs/concepts/merge-semantics) — the default per-section merge
- [MCP tools](/docs/reference/mcp-tools) — where `suppressed` and `conflicts` surface
- [Override syntax in a manifest](/docs/reference/manifest) — the layers these overrides act across
