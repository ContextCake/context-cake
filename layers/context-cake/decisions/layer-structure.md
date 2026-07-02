---
type: decision
title: Layer structure
updated: 2026-06-24
tags: [architecture, layers]
---

# Layer structure

## Layers {#layers}

Three layers, each with an explicit numeric level:

| Layer    | Level | Wins over |
|----------|-------|-----------|
| personal | 3     | team, company |
| team     | 2     | company |
| company  | 0     | nothing |

Level is a visible setting in the manifest, not hidden logic. Higher level wins
per section. The fourth "Group" layer from the prior architecture was dropped — it
was speculative and added a concept without clear value.

## Source types {#source-types}

A layer declares its `source` in the manifest:
- `okf-local` — a directory (or git repo) of OKF markdown files on disk. Default.
- `mcp` — a foreign graph reachable only over a stdio MCP server. The adapter
  spawns the server, queries it, and translates its response into OKF on the way in.

OKF is the canonical output regardless of source type.

## Manifest {#manifest}

The manifest (`layers.json`) is gitignored — each developer has their own absolute
paths. The manifest is a trust boundary: an `mcp` layer spawns `command` with `args`
from the manifest. Only point `--manifest` at configs you trust.

## Related {#related}

[[resolution-model]], [[source-contract]], [[/architecture/overview]]
