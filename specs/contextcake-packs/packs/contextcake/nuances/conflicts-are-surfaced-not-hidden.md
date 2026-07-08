---
type: nuance
updated: 2026-07-08
---

# Conflicts are surfaced, not hidden {#conflicts-are-surfaced-not-hidden}

When two layers define the same section with different content, ContextCake
does not quietly pick the higher layer and discard the rest. The losing
layer's value rides along as a first-class part of the response.

## The shape: `conflicts[]` on a section {#the-shape}

Every resolved section can carry an optional `conflicts` array, one entry
per dissenting contributor:

```json
{
  "key": "choice",
  "heading": "## Choice {#choice}",
  "content": "Postgres in every shared environment...",
  "sourceLayer": "personal",
  "sourceUpdated": "2026-06-28",
  "conflicts": [
    {
      "layer": "company",
      "updated": "2026-05-01",
      "content": "Postgres (org standard). All services provision managed RDS..."
    }
  ]
}
```

`sourceLayer` and `sourceUpdated` describe the winner. Each entry in
`conflicts` describes a layer that defined the same section differently —
its name, when it was last updated, and its full content, not just a diff.
An agent reading this gets the primary answer plus everything it would need
to disagree with that answer if the dissenting version turns out to matter
more in context.

## Silent resolution is the common case {#silent-resolution-is-common}

Most sections do not conflict. A section resolves silently — no `conflicts`
key at all — when only one layer defines it (pure inheritance, nothing to
disagree about) or when multiple layers define it identically. Conflicts
only appear where layers actually disagree on content, which in practice is
the minority of sections in a healthy knowledge base. Suppressed sections
(`{#anchor override=none}`) also emit no conflicts — the suppression itself
is the answer, not a disagreement to record.

## Layer plus date, not a full diff engine {#layer-plus-date}

The provenance ContextCake attaches is deliberately narrow: which layer said
this, and when that layer last touched it. It is not a change history, not
a diff against the winning value, and not an explanation of *why* the
layers disagree. That judgment call is left to whoever — human or agent —
reads the resolved concept. The `updated` date is enough to answer the one
question that matters most: is the dissenting version newer than the
version that won? See `nuances/precedence-and-recency.md` for why a newer
loser does not become the winner automatically.

## The old shadow/hash drift detector is gone {#shadow-hash-detector-is-gone}

An earlier version of the engine tried to catch staleness a different way:
hashing each layer's content and flagging when a lower layer's underlying
value silently drifted out of sync with what a higher layer had overridden
(`detectShadow`, `--shadow`, `--hash`, `hashConcept`, and the
`overrides_ref`/`overrides_layer` metadata that supported it). That whole
subsystem has been removed. There is no hash comparison running anywhere in
the current engine, and no `--shadow` or `--hash` flags to reach for.

Staleness is now surfaced entirely through `conflicts[]` plus each
contributor's `updated` date — the same mechanism that surfaces
disagreement in general. This is a real, accepted tradeoff: it trusts
authors to bump a concept's `updated` field when they actually change
content. A base-layer edit that forgets to bump the date will not show up
as newer than it should, where the old hash mechanism would have caught
content drift regardless of whether a date changed. The project has chosen
simplicity over that guarantee; if lax date discipline becomes a real
problem in practice, the documented fallback is a stitch-time content
fingerprint computed at read time with no author action required — but that
is explicitly not built today.

## What this means for you {#what-this-means-for-you}

Do not build tooling or agent prompts that assume ContextCake will flag
stale content automatically. It will not scan your layers looking for drift.
What it will do, reliably, is show you every layer's answer and every
layer's date whenever there is disagreement — the judgment step is yours or
your agent's, every time.

## Next {#next}

- `nuances/precedence-and-recency.md` — why the winning layer does not
  change just because a dissenting value is newer
- `overview/mental-model.md` — the layer stack this conflict model sits on
