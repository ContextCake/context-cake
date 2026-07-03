---
title: Foreign MCP sources
description: Stitch a non-OKF knowledge graph in over stdio MCP.
---

A layer doesn't have to be an OKF bundle on disk. It can be any foreign
knowledge graph reached over a stdio MCP server — ContextCake spawns it,
queries it, and translates its arbitrary response shape into OKF at read
time, so it stitches in alongside your local bundles.

## Declaring an mcp layer

A layer in `layers.json` declares a `source`. `source` defaults to
`okf-local` when omitted; set it to `mcp` to reach a foreign graph:

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

`command` and `args` are exactly what gets spawned. There's no separate
transport config — the child process talks MCP over its stdin/stdout.

:::caution
An `mcp` layer spawns `command` with `args` from the manifest. A manifest you
did not author can run arbitrary commands as your user. Only point
`--manifest` at configs you trust — same model as any MCP client config. See
[the trust boundary](/docs/concepts/trust-boundary).
:::

## How it's translated

The adapter (`sources/mcp.mjs`) speaks the MCP handshake — `initialize`, then
`notifications/initialized` — before issuing any tool calls, and calls two
tools on the foreign server:

- `list_nodes` — returns the set of node ids the graph exposes.
- `get_node { id }` — returns one node's record, in whatever shape the
  foreign server uses.

Each `get_node` result is translated into an OKF concept:

- Frontmatter `type` comes from the node's `kind` (falls back to
  `"concept"`); `title` from the node's `title` (falls back to the node id).
  `updated` is the most recent `lastTouched` across the node's facts.
- Each fact becomes a section: `{ topic, text, lastTouched }` becomes a
  `## Topic {#topic}` heading with `text` as its body and `lastTouched` as
  the section's `updated` date — the same shape the resolver uses for
  per-section provenance and conflict comparison against local layers.
  Frontmatter `type` is required in OKF, so this mapping is what makes a
  foreign node a first-class concept in the cascade.
- A `see_also` list of node ids becomes a single `## Related {#related}`
  section with `[[wikilink]]` references, so the foreign graph's
  cross-references stay traversable through `get_links`.

Because a foreign source degrades independently — a spawn failure, a crash,
or a request timeout all resolve to "no data from this source" rather than
failing the whole cascade — a broken MCP source shows up as unreachable
without taking down the layers around it.

## Walking the runnable example

`examples/mock-context-source.mjs` is a deliberately non-OKF mock graph
exposed over stdio MCP — it stands in for "some foreign graph you can only
reach via MCP." It implements exactly the two tools the adapter expects:

```js
"decisions/database-engine": {
  node: "database-engine",
  category: "decisions",
  title: "Database engine",
  kind: "decision",
  facts: [
    { topic: "Engine", text: "Postgres (org standard).", lastTouched: "2026-06-01" },
    { topic: "Backups", text: "Nightly snapshots to cold storage.", lastTouched: "2026-03-01" },
  ],
  see_also: ["decisions/scaling-policy"],
}
```

Wire it into a manifest as the `mcp` layer:

```json
{ "layers": [
  { "name": "team", "level": 2, "source": "okf-local", "path": "./demo-layers/team" },
  { "name": "company", "level": 0, "source": "mcp", "command": "node", "args": ["./examples/mock-context-source.mjs"] }
] }
```

Resolve a concept it exposes and the resolver stitches it in like any other
layer:

```bash
node resolver.mjs --manifest layers.json --concept decisions/database-engine
```

The output carries the same shape as an all-local resolve: `contributors`
lists the mock server alongside any local layers, each section carries the
`sourceLayer` that won it, and disagreements between the foreign graph and a
local layer surface as `conflicts[]` — the mock server is just another voice
in the cascade, not a special case.

## Next

- [The trust boundary](/docs/concepts/trust-boundary) — what spawning a
  manifest command means for your machine
- [The manifest reference](/docs/reference/manifest) — full `layers.json`
  shape, including `source: mcp` fields
- [Playground tour](/docs/guides/playground-tour) — add an MCP source
  visually and watch it resolve
- [Merge semantics](/docs/concepts/merge-semantics) — how sections from
  different sources combine
