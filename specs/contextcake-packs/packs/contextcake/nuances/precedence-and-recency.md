---
type: nuance
updated: 2026-07-08
---

# Precedence and recency {#precedence-and-recency}

The rule sounds simple — higher layer wins — but it is worth being precise
about what "higher" means, because it is easy to assume recency plays a
role when it does not.

## Level dominates, full stop {#level-dominates}

Precedence is decided purely by the layer's `level` in the manifest. If
Personal (level 3) and Company (level 0) both define the `Choice` section
of a concept, Personal wins that section — even if the Company section was
edited an hour ago and the Personal section has not been touched in months.
Level is a static, configured fact about the layer, not something that
shifts based on which edit happened most recently.

This is a deliberate simplification. An earlier version of the resolver
considered same-level recency (`updated=` timestamps) as a tiebreak. That
logic is gone: with three distinct default levels (3, 2, 0), there is no
same-level tie to break, and the design explicitly cut the recency-tiebreak
and DAG same-level resolution machinery as unnecessary complexity.

## No same-level ties in the default stack {#no-same-level-ties}

Because Personal, Team, and Company sit at three distinct levels by default,
there is no built-in rule for what happens when two layers share a level —
the situation does not arise unless you configure it that way yourself. If
you add a layer and give it the same level as an existing one, you are
opting into undefined tie behavior; the supported model is one layer per
level.

## Order is a visible setting {#order-is-a-visible-setting}

Nothing about precedence is implicit. The levels live in `layers.json`,
readable and editable:

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

If you want Team to outrank Personal for some reason, that is a one-line
manifest edit, not a code change. The tradeoff is that whoever edits the
manifest controls precedence for everyone reading through that manifest —
treat it with the same care as any config that changes what "the truth"
means for your agents.

## Recency still matters — just not for winning {#recency-still-matters}

Dropping recency from the precedence rule does not mean dates are ignored.
Every resolved section carries `sourceUpdated`, and every conflict carries
its own `updated` date. Recency is the signal you use to judge a resolved
answer, not the rule that produces it. If Company's dissenting value on a
section is dated *after* the Personal value that won, you see that
juxtaposition directly — a newer, lower-precedence value sitting next to an
older, higher-precedence one — and decide for yourself whether the win is
still the right call. See `nuances/conflicts-are-surfaced-not-hidden.md`.

## The flapping tradeoff {#the-flapping-tradeoff}

Precedence-by-level rather than precedence-by-recency is a real tradeoff,
not a free lunch. The alternative — let the most recently updated layer win
regardless of level — sounds appealing until you picture it running: any
layer could reclaim precedence on a section just by touching it, so the
"winner" for a given section could flap back and forth depending on who
edited last, with no floor. A personal scratch note touched five minutes
ago would out-rank a carefully reviewed company policy from last month.

Fixed levels trade that instability for a small amount of staleness risk
(a section can go stale under a layer that outranks it and nothing forces a
re-check) in exchange for an answer that does not change identity just
because someone edited an unrelated layer. Given the resolver runs fresh at
every read anyway (see `overview/mental-model.md`), staleness is visible the
moment you look, which is judged an acceptable price for predictable
winners.

## Next {#next}

- `nuances/conflicts-are-surfaced-not-hidden.md` — how dissent and dates are
  represented on a resolved section
- `overview/mental-model.md` — the layer cake this precedence rule governs
