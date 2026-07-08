---
type: architecture
updated: 2026-07-08
---

# Conflicts and provenance {#conflicts-and-provenance}

ContextCake returns one primary answer per concept and is honest about
dissent. Where layers disagree on a section, the higher layer's value wins as
primary, and the dissenting layers ride along — tagged with their layer name
and last-updated date. The contradiction is **surfaced, not hidden**.

## Per-section conflicts {#per-section-conflicts}

A conflict is attached to the specific section that disagrees, not to the
whole concept. When another contributor defines a section with content that
differs from the winner, the resolved section carries:

```json
"conflicts": [
  { "layer": "company", "updated": "2026-05-01", "content": "..." }
]
```

Sections where every contributing layer agrees, or that only one layer
defines, resolve silently — no `conflicts` array at all. That is the
common, non-contentious path: most sections in most concepts inherit cleanly.
Suppressed sections (see `architecture/section-merge.md`) also carry no
conflicts — the tombstone is the answer, so there is nothing left to
disagree about.

## Provenance at three levels {#provenance-at-three-levels}

A resolved concept carries provenance so an agent can weight facts by trust
level, not just read a flat answer:

- **`contributors`** — every layer that defines this concept at all, each as
  `{ layer, level, updated }`.
- **`frontmatterProvenance`** — for each frontmatter field, which layer
  supplied the winning value.
- **`sections[].sourceLayer` / `sourceUpdated`** — which layer won each
  section, and when that layer last touched it.

`layer` here doubles as a trust signal: a section sourced from `company` and
a section sourced from an unreviewed `personal` draft carry different
implicit weight, even though both are the "primary" answer for their
respective sections.

## Dates are the staleness signal {#dates-are-the-staleness-signal}

`updated` — on the winning section and on every conflict — is the whole
staleness story. There is no separate hash-based drift detector watching for
silent changes; ContextCake trusts authors to bump `updated` when content
changes, and asks the reader to compare dates directly. If a dissenting
layer's version is newer than the section that beat it on precedence, you see
that plainly and judge for yourself:

```
decisions/database-engine

  SingleStore                    <- primary   (team,        updated 2026-05-12)
  Chosen for HTAP / reporting workloads.

  company disagrees:
    Postgres                               (company, updated 2026-06-01)  <- newer
```

This is an accepted trade-off: date discipline is on the author, not enforced
by content hashing. A prior version of ContextCake had a shadow/hash
drift-detection subsystem; it was removed in favor of this simpler, honest
date comparison.

## Next {#next}

- `architecture/section-merge.md` — how the winning section is chosen before
  a conflict is even possible
- `architecture/the-mcp-server.md` — how `read_file` surfaces `contributors`,
  `frontmatterProvenance`, and per-section `conflicts` to an agent
- `architecture/layers-and-precedence.md` — where layer precedence, the thing
  that decides "primary," comes from
