---
title: The capture write path
description: Classify repo activity into signals and write durable context to a layer.
---

Classify repo activity into signals and write durable context to a layer.

**Source material:** README write path + `ingest.mjs` / `write.mjs`

<!-- TODO(agent): port + correct from the SOURCE named above, per specs/contextcake-site/design.md §5.
     Correctness rule: write against current engine source, not docs/architecture.md.
     Stale (removed) subsystems that must NOT appear: --hash, --shadow,
     override: exception, Group layer, recency tiebreak. -->
