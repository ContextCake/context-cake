---
type: concept
title: ContextCake — what it is
updated: 2026-06-25
tags: [architecture, overview]
---

# ContextCake — what it is

## One sentence {#one-sentence}

ContextCake stitches your separate knowledge graphs — personal, team, company — into
one OKF graph your agent can read, returning a primary answer and being honest about
contradictions: which layers disagree, and when each was last updated.

## What it is not {#not}

ContextCake is not a knowledge store. It owns no source of truth. The graphs already
exist, in different places. ContextCake is the layer that makes them talk — OKF is
the language they all speak once stitched.

## Status {#status}

Re-architected into a stitching layer (2026-06-25, PR #1 merged). All tests passing:
`smoke-test.sh`, `resolver-test.sh`, `source-test.sh`. The demo track (`demo/`) is
currently broken — its `setup.sh` and `verify.sh` still reference the removed
`--shadow/--hash` flags. Pending reconciliation.

## Outstanding {#outstanding}

- Promotion-up-the-stack: generalize `promote.mjs` from personal→shared to multi-level
- Nested YAML for `overrides:` frontmatter (blocked on real YAML parser adoption)
- Demo track: swap shadow beat → dates-based conflict beat in `setup.sh`/`verify.sh`
- Pretty printer for `resolver.mjs` (`--pretty` flag for human-readable waterfall output)
- Membrain adapter: needs a protocol shim (`search_nodes`/`open_nodes` → `list_nodes`/`get_node`)

## Related {#related}

[[/decisions/resolution-model]], [[/decisions/layer-structure]], [[/decisions/conflict-policy]]
