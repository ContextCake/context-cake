---
type: decision
title: Conflict policy
updated: 2026-06-24
tags: [architecture, conflicts]
---

# Conflict policy

## Surface, don't hide {#surface}

When layers disagree on a section, both values are surfaced. The higher layer's value
is primary; the dissenting layer's value is attached with its source name and
`updated` date. The reader — human or agent — sees the disagreement and can judge.

This replaces the prior shadow/hash staleness subsystem (~40 lines of machinery
that tried to detect drift automatically). The new approach trusts authors to bump
`updated` when they change content. The accepted trade-off: an edit that doesn't
bump the date won't flag. If date discipline proves unreliable, the fix is a
stitch-time fingerprint — deferred, not built.

## Shape {#shape}

Each resolved section may carry:
```
conflicts: [{ layer: "company", updated: "2026-06-01", content: "Postgres (org standard)." }]
```

Sections with no conflict resolve silently — no `conflicts` array, just inherited.

## What was cut {#cut}

- Shadow/staleness: `detectShadow`, `--shadow`, `--hash`, `hashConcept`
- `override: exception` governance metadata
- Section-level `updated=` recency tiebreak
- Same-level DAG resolution (moot with 3 distinct levels)

## Related {#related}

[[resolution-model]]
