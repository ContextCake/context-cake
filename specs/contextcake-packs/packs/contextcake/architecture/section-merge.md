---
type: architecture
updated: 2026-07-08
---

# Section merge {#section-merge}

The resolver merges concepts **section by section**, not by replacing one
document with another. This is the core behavior that makes the layer cake
useful instead of just a priority list: a higher layer only needs to speak to
what it actually wants to change.

## Section merge, not whole-document replacement {#not-whole-document-replacement}

For each section — identified by its `{#anchor}` — the resolver picks a
winner independently:

- The highest layer that defines a given section wins that section.
- Every section the winner does not restate is **inherited** from whichever
  lower layer defines it.
- Frontmatter is field-merged the same way: for each key, the highest layer
  that sets it wins that field, and unset keys fall through to lower layers.

Nothing is lost just because a higher layer touched a neighboring section.

## Walking through an example {#walkthrough}

Take `decisions/primary-db`, defined by both Company and Team. The Company
layer's file has two sections: an `Engine` section (anchor `#engine`) that
says "Postgres.", and a `Backups` section (anchor `#backups`) that says
"Nightly snapshots to cold storage." The Team layer's file has only one
section — the same `Engine` anchor — that says "SingleStore (chosen for HTAP
workloads)."

Team only speaks to `Engine`. The resolver merges them into one effective
concept: the `Engine` section resolves to Team's value, because Team (higher
level) restated that anchor; the `Backups` section resolves to Company's
value, untouched, because Team never mentioned it.

Team's silence on `Backups` is not an override of anything — it just means
Team never spoke, so Company's version passes through unchanged. If Company
and Team's `Engine` sections had different content, the resolved section would
also carry a `conflicts` entry recording Company's dissenting value — see
`architecture/conflicts-and-provenance.md`.

## Two escape hatches {#escape-hatches}

Default section merge covers the common case. Two pieces of syntax opt out of
it:

| Syntax | Behavior |
|--------|----------|
| *(default)* | Section/field merge — higher layer wins per key |
| `override: full` in frontmatter | Whole-concept replacement; everything below is dropped |
| `{#anchor override=none}` | Tombstone — suppresses the inherited section |

### `override: full` {#override-full}

Setting `override: full` in a layer's frontmatter replaces the entire
concept. Every lower contributor is dropped for that concept — no section
merge, no inherited sections, no conflicts recorded. Use it sparingly; it
opts a concept out of inheritance entirely, which is rarely what you want
for more than one or two sections at a time.

### `{#anchor override=none}` — the tombstone {#the-tombstone}

To suppress a single inherited section without replacing the whole concept, a
higher layer defines that section — say a `Rollback` section, anchor
`#rollback` — with `override=none` added to that anchor and no content
underneath: `{#rollback override=none}`.

The section disappears from the effective body, but it is not silently
dropped from the record — the resolved output keeps it, marked
`suppressed: true`, so the suppression is auditable. A suppressed section
never carries `conflicts`: the tombstone itself is the answer, and there is
nothing left to disagree about.

This is deliberately the *only* rule beyond "higher wins" and "conflicts are
shown with dates" — the mental model stays at two rules plus one escape
hatch.

## Next {#next}

- `architecture/conflicts-and-provenance.md` — what rides along when layers
  disagree on a section
- `architecture/layers-and-precedence.md` — where the per-layer level that
  decides a winner comes from
- `architecture/okf-format.md` — how `{#anchor}` syntax is written in a file
