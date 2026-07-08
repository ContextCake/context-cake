---
type: overview
updated: 2026-07-08
---

# The mental model {#the-mental-model}

One picture carries most of what you need: three layers, stacked by level,
higher wins.

```
Personal  (level 3)  ← your drafts, notes, overrides
────────────────────
Team      (level 2)  ← runbooks, decisions, system docs
────────────────────
Company   (level 0)  ← org-wide canonical knowledge
```

## Levels, not names, decide precedence {#levels-decide-precedence}

`personal`, `team`, and `company` are the default names, but what actually
governs precedence is the numeric `level` each layer declares in the
manifest — 3, 2, and 0 by default. The gaps (skipping 1) are intentional:
they leave room to slot another layer into the stack later without
renumbering everything above it. Levels are a visible, configurable setting
you read straight out of `layers.json` — not hidden logic baked into the
engine. See `nuances/precedence-and-recency.md` for what happens at the
edges of this rule.

## Higher wins — per section, not per document {#higher-wins-per-section}

This is the detail that makes the model actually useful instead of just
simple. When the same concept exists in two layers, the higher layer does
not replace the whole document — it wins only the sections it actually
speaks to. Everything it stays silent on is inherited from the layer below.

```markdown
<!-- Company layer: decisions/primary-db.md -->
[Engine] {#engine}
Postgres.

[Backups] {#backups}
Nightly snapshots to cold storage.

<!-- Team layer: decisions/primary-db.md -->
[Engine] {#engine}
SingleStore (chosen for HTAP workloads).

<!-- Effective (what agents see): -->
[Engine]        -- Team wins
SingleStore (chosen for HTAP workloads).

[Backups]       -- inherited from Company
Nightly snapshots to cold storage.
```

Team only spoke to `Engine`. It said nothing about `Backups`, so that
section flows through from Company untouched. Nothing is lost just because a
higher layer happened to weigh in on a neighboring section — the guiding
rule is **no knowledge lost**.

## One effective graph at read time {#one-effective-graph-at-read-time}

Nothing is pre-merged or cached into a fourth copy of the data. Each layer's
source stays exactly where it lives — a git bundle on disk, or a foreign
graph behind an MCP server — and the resolver (`resolver.mjs`) walks all of
them fresh every time an agent asks for a concept, stitching the result into
one effective OKF concept on the spot. Ask again after someone edits the
team layer, and the new answer reflects that edit immediately, with no sync
step in between.

This is also why the same concept ID can exist in every layer at once and
still resolve to one answer: a concept's ID is its file path within the
bundle (minus `.md`), and it is stable across layers — `decisions/primary-db.md`
in Company, Team, and Personal are three contributions to the *same*
effective concept `decisions/primary-db`, not three different concepts.

## What a resolved answer carries {#what-a-resolved-answer-carries}

An agent reading a resolved concept through the MCP server's `read_file`
tool does not just get merged text — it gets provenance: which layer won
each section (`sourceLayer`), when that layer last touched it
(`sourceUpdated`), and which layers contributed at all (`contributors`).
Where layers disagree, the dissenting versions ride along too. See
`nuances/conflicts-are-surfaced-not-hidden.md`.

## Next {#next}

- `nuances/precedence-and-recency.md` — ties, staleness, and the flapping
  tradeoff
- `nuances/conflicts-are-surfaced-not-hidden.md` — what happens when layers
  disagree
