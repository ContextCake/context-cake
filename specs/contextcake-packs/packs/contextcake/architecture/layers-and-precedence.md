---
type: architecture
updated: 2026-07-08
---

# Layers and precedence {#layers-and-precedence}

ContextCake stacks your knowledge into a small number of layers, each with a
precedence level, and resolves them into **one effective concept** whenever an
agent asks for something. This file is the anchor for the rest of
`architecture/` — read it first.

## The three layers {#the-three-layers}

The default stack is three layers, ordered by level:

```
Personal  (level 3)  higher — your drafts, notes, overrides
Team      (level 2)
Company   (level 0)  lower  — org-wide canonical knowledge
```

Higher level wins. Personal overrides Team, Team overrides Company. There is
no fourth "Group" layer — earlier drafts of the design considered one, but it
was speculative and was dropped before implementation.

## Levels are configuration, not hidden magic {#levels-are-configuration}

Layer order lives in `layers.json`, the manifest, as a plain integer per
layer:

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

You can see the precedence order by reading the manifest, and you can change
it by editing a number. There is no separate ranking system, no code path that
special-cases a layer by name. `personal`, `team`, and `company` are
convention, not reserved words — any names and any integers work, and the
default levels (3, 2, 0) deliberately leave gaps so more layers can slot in
later without renumbering everything else.

## One effective concept per read {#one-effective-concept}

When an agent (or the CLI) asks for a concept, `resolver.mjs` looks at every
layer that defines that concept ID and merges them into a single answer. It
does this **per section**, not per document — see
`architecture/section-merge.md` for the mechanics. The result is one OKF
concept with:

- a primary value for every section, chosen by the highest layer that speaks
  to it
- provenance recording which layer won each section and each frontmatter
  field
- any dissenting layers attached as `conflicts`, never silently dropped

An agent reading a resolved concept never has to query three layers itself
and reconcile them by hand. It asks once, gets one answer, and gets told
exactly where that answer came from.

## Precedence is purely by level {#precedence-is-purely-by-level}

There is no same-level tiebreak rule in the default stack, because every
layer has a distinct level. If you configure two layers at the same level,
the first one listed in the manifest wins ties for that level — but the
common case is that levels are already distinct and this never comes up.

Precedence is decided by level alone — never by recency, section order, or
which layer happens to be queried first. A newer edit in a lower layer does
not outrank an older one in a higher layer; see
`architecture/conflicts-and-provenance.md` for how staleness is surfaced
instead of used as a tiebreak.

## Where each layer's knowledge lives {#where-knowledge-lives}

Layers are federated storage, not a shared database — see
`architecture/federated-storage-and-sources.md` for the `source` adapter
seam that lets a layer be a local git bundle or a foreign MCP graph. Access
control on `okf-local` layers is free: repo membership is read access to
that layer.

## Next {#next}

- `architecture/section-merge.md` — how a section's winner is chosen and how
  the rest is inherited
- `architecture/conflicts-and-provenance.md` — what happens when layers
  disagree
- `architecture/federated-storage-and-sources.md` — what a layer actually is
  under the `source` field
