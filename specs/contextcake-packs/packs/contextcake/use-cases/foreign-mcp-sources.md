---
type: use-case
updated: 2026-07-08
---

# Stitching in a company graph you can only reach over MCP {#foreign-mcp-sources}

Not every layer is a git repo of markdown you control. Sometimes the
company's knowledge graph is a real system — a wiki backend, a support tool,
an internal API — that you can only reach the way any AI agent would: over
MCP. ContextCake treats that as just another source.

## The problem {#the-problem}

Your personal and team layers are `okf-local` bundles — directories of OKF
markdown in git repos you can clone. But company knowledge often lives
behind a service you don't control the storage format of. You can't check
its database into a git bundle, and you don't want to build and maintain a
sync job that mirrors it into one. You want to query it live, as-is, and
have it resolve into the same cascade as everything else.

## The fix: a `source: mcp` layer {#the-fix}

A layer in the manifest declares its `source`. `okf-local` is the default;
setting `source: mcp` tells ContextCake to reach this layer by spawning a
stdio MCP server instead of reading a directory:

```json
{ "name": "company", "level": 0, "source": "mcp",
  "command": "node", "args": ["./company-graph-server.mjs"] }
```

`command` and `args` are exactly what gets spawned — no separate transport
config. The adapter (`sources/mcp.mjs`) does the MCP handshake, then calls
two tools the foreign server must expose: `list_nodes` (the set of node ids)
and `get_node { id }` (one node's record, in whatever shape the foreign
server already uses).

## Translation to OKF {#translation-to-okf}

Each `get_node` result becomes an OKF concept at read time — nothing is
written to disk. The node's `kind` becomes frontmatter `type`; each fact
`{ topic, text, lastTouched }` becomes a section, `text` as the body and
`lastTouched` as that section's `updated` date, which is exactly what the
resolver needs to compare it against a local layer's `updated` date when
they disagree. A `see_also` list becomes a `Related` section with
wikilinks, so the foreign graph's cross-references stay traversable through
`get_links`.

## A runnable example {#a-runnable-example}

`examples/mock-context-source.mjs` in the repo is a deliberately non-OKF
mock graph exposed over stdio MCP — it stands in for "some real system you
can only reach via MCP." Point a manifest at it and resolve a concept it
exposes:

```bash
node resolver.mjs --manifest layers.json --concept decisions/database-engine
```

The output looks like any other resolve: `contributors` lists the mock
server alongside local layers, each section carries the `sourceLayer` that
won it, and a disagreement between the foreign graph and a local layer shows
up in `conflicts[]` — the foreign source is just another voice in the
cascade, not a special case the agent has to reason about differently.

## Failure is isolated {#failure-is-isolated}

A spawn failure, a crash, or a request timeout on an `mcp` layer all resolve
to "no data from this source," not a failed resolve. The layers around it
still answer.

## The cost of this power {#the-cost-of-this-power}

An `mcp` layer runs `command` with `args` taken straight from the manifest —
whoever controls the manifest controls what gets executed as you. Only
point `--manifest` at a config you trust; see
`architecture/the-manifest-and-trust-boundary.md`.

## Next {#next}

- `examples/layers-json-example.md` — the full manifest shape, including an
  `mcp` layer's fields
- `architecture/the-manifest-and-trust-boundary.md` — what spawning a manifest
  command means for your machine
