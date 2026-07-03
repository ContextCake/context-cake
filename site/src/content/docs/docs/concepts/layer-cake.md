---
title: The layer cake
description: Layers are git repos per organizational scope; higher layers win per section.
---

Knowledge lives in separate git repos, one per organizational scope. ContextCake
stacks them into a cascade and resolves them into one effective view at read time.
Access control is free: repo membership is read access to that layer. If you can
clone the repo, you can read the layer; if you cannot, it never contributes.

## Three layers

The default stack is three layers, ordered by level. Higher levels sit on top.

```
Personal  (level 3)  ← your drafts, notes, overrides
────────────────────
Team      (level 2)  ← runbooks, decisions, system docs
────────────────────
Company   (level 0)  ← org-wide canonical knowledge
```

Levels are the precedence axis, and they are a visible setting in the
[manifest](/docs/reference/manifest) — not hidden magic. Higher level wins, and you
can see (and change) the order. The default levels leave gaps (3, 2, 0) so more
layers can slot in later without renumbering.

## Higher layers win — per section

When a concept exists in multiple layers, the higher layer wins **per section**, not
per document. A higher layer speaks to what it knows; everything it does not restate
is inherited from below. Nothing is dropped just because a layer above touched a
neighboring section. **No knowledge lost.**

Take a concept `decisions/primary-db.md` that both the Company and Team layers
define:

```markdown
<!-- Company layer: decisions/primary-db.md -->
## Engine {#engine}
Postgres.

## Backups {#backups}
Nightly snapshots to cold storage.

<!-- Team layer: decisions/primary-db.md -->
## Engine {#engine}
SingleStore (chosen for HTAP workloads).

<!-- Effective (what agents see): -->
## Engine       ← Team wins
SingleStore (chosen for HTAP workloads).

## Backups      ← inherited from Company
Nightly snapshots to cold storage.
```

The Team layer only spoke to `Engine`, so it wins that section. It said nothing about
`Backups`, so the Company section is inherited untouched. This is
[section-level merge](/docs/concepts/merge-semantics), the core behavior of the
resolver.

Where two layers define the same section with *different* content, the higher layer
is still primary — but the dissenting layer rides along as a
[conflict, surfaced with its date](/docs/concepts/conflicts-and-provenance), never
silently discarded.

## Why git repos

Each layer is a [source](/docs/concepts/okf-bundles) behind a uniform adapter. The
default source is an `okf-local` bundle: a git repo of OKF markdown on disk. A layer
can also be a foreign knowledge graph reached over MCP and translated to OKF at read
time (see [foreign MCP sources](/docs/guides/foreign-mcp-sources)). Either way, the
resolver stitches them into one OKF graph.

Storing each scope as its own repo means access is governed by the tool your org
already uses to govern repos. There is no separate ACL system to maintain — the
company repo is readable by the company, the team repo by the team, your personal
repo by you.

## Next

- [OKF bundles](/docs/concepts/okf-bundles) — what a layer actually contains
- [Merge semantics](/docs/concepts/merge-semantics) — the exact precedence and override rules
- [Your first cascade](/docs/getting-started/first-cascade) — build your own layers
