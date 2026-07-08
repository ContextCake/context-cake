---
type: guide
updated: 2026-07-08
---

# Writing a layer {#writing-a-layer}

A layer is a directory of OKF (Open Knowledge Format) markdown files. This is
the file shape every `okf-local` layer resolves from.

## Concept ID = file path {#concept-id-equals-file-path}

A concept's ID is its file path within the layer's directory, minus `.md`. The
file `decisions/primary-db.md` is the concept `decisions/primary-db`. That ID
must be **stable across layers** — company, team, and personal can each hold a
file at `decisions/primary-db.md`, and the resolver treats all three as
contributions to one effective concept.

## Frontmatter {#frontmatter}

Every concept file starts with YAML frontmatter. The only required field is
`type`:

```markdown
---
type: decision
updated: 2026-06-20
---
```

`updated` is not required by the engine but you should always set it — it is
the entire staleness signal. There is no separate drift-detection subsystem;
when layers disagree on a section, an agent (or you) judges recency by
comparing `updated` dates across the `conflicts` entries. A layer that forgets
to bump `updated` after a real change won't be flagged automatically.

## Sections need anchors {#sections-need-anchors}

Every heading that should resolve as an independently-mergeable unit needs a
`{#anchor}`:

```markdown
## Engine {#engine}

SingleStore (chosen for HTAP workloads).

## Backups {#backups}

Nightly snapshots to cold storage.
```

The anchor, not the heading text, is the merge key. Two layers with `## Engine
{#engine}` are contributing to the *same* section even if they word the
heading slightly differently; keep anchors identical across layers for a
concept you intend to merge.

## How a higher layer overrides a section {#how-a-higher-layer-overrides-a-section}

Default behavior is **section merge, not whole-document replacement**. A
higher-precedence layer only needs to restate the sections it actually
disagrees with or adds to:

```markdown
<!-- team layer, overriding only Engine -->
## Engine {#engine}

SingleStore (chosen for HTAP workloads).
```

If `team` doesn't mention `Backups` at all, the resolved concept still
contains `Backups`, inherited untouched from whichever lower layer defines it.
Nothing needs to be copy-pasted forward.

## Two escape hatches {#two-escape-hatches}

- `override: full` in frontmatter replaces the **entire** concept for that
  layer and below — use sparingly, it forfeits section-level inheritance.
- `{#anchor override=none}` on a heading is a tombstone: it suppresses an
  inherited section without restating content to negate it. The suppression
  is retained as `suppressed: true` for audit, so it's visible, not silent.

## Next {#next}

- `getting-started/your-first-cascade.md` — resolve a two-layer example end to end
- `getting-started/connect-an-ai-agent.md` — expose the resolved graph to an agent over MCP
