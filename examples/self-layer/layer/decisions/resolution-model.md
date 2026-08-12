---
type: decision
title: Resolution model
updated: 2026-06-24
tags: [architecture, resolver]
---

# Resolution model

## Rules {#rules}

Two rules plus one escape hatch:

1. **Higher layer wins per section.** Personal (level 3) beats team (level 2) beats
   company (level 0). This applies at the section level, not the whole document.
2. **Conflicts are shown with dates, not hidden.** Every section that has dissent
   carries a `conflicts` array: which layer disagreed, what it said, when it was
   last updated. The date is the staleness signal.
3. **Escape hatch: `override=none` suppression.** A higher layer may blank an inherited
   section it declares doesn't apply. This is the only rule beyond the two above.

The goal was to go from ~7 resolution rules in the prior architecture to exactly two
plus one escape hatch. Any new rule that can't be collapsed into these three is cut.

## Section-level merge {#section-merge}

Sections are keyed by their `{#anchor}` slug. A higher layer's section wins for that
key; all non-conflicting keys from lower layers are inherited silently. The result is
a composite concept where different sections may come from different layers.

## Provenance {#provenance}

Every resolved section carries `sourceLayer` and `sourceUpdated` so an agent can
see exactly where each section originated.

## Related {#related}

[[conflict-policy]], [[layer-structure]], [[source-contract]]
