---
type: architecture
updated: 2026-07-08
---

# The MCP server {#the-mcp-server}

`mcp-server.mjs` is the read surface AI agents connect to. It is a stdio MCP
server that exposes the resolved cascade — not raw layer files — as one
effective, read-time OKF graph. Every read goes through the same section and
field merge as the CLI: level precedence, provenance, per-section conflicts,
over every source declared in the manifest.

```bash
node mcp-server.mjs --manifest layers.json
```

## The four tools {#the-four-tools}

| Tool | What it returns |
|------|------------------|
| `search` | Full-text search across all layers; one entry per concept, with the layers that contributed to it |
| `read_file` | The resolved effective concept — section merge, provenance, per-section conflicts |
| `list_concepts` | Every effective concept ID, with contributing layers |
| `get_links` | Outgoing and incoming links, resolved against the effective graph |

### search {#search}

Full-text search across every layer, scored and deduplicated by concept ID.
Arguments: `query` (required), `limit` (default 10). Each result is
`{ id, title, score, layers, snippet }`, with `layers` ordered by level,
highest first — so an agent can tell at a glance whether a hit is backed by
Company policy, a Team runbook, or just a Personal note.

### read_file {#read_file}

The core tool. Reads the resolved concept across the whole cascade, with full
provenance: `contributors`, `frontmatterProvenance`, and per-section
`sourceLayer` / `sourceUpdated` / `conflicts` / `suppressed`. See
`architecture/conflicts-and-provenance.md` for what those fields mean and
`architecture/section-merge.md` for how the merge that produces them works.

Arguments: `concept_id` (required), `layer` (optional). Passing `layer`
skips the merge entirely and returns that one layer's raw, unmerged concept
as stored — useful for auditing what a specific layer actually says, versus
what the cascade resolves to.

### list_concepts {#list_concepts}

Lists every effective concept ID across the cascade, each with its
contributing layers. Optional `type` argument filters by the resolved
effective OKF `type`. This is how an agent (or a UI) discovers what exists
without knowing concept IDs up front.

### get_links {#get_links}

Returns outgoing and incoming links for a concept, resolved against the
effective graph — not any single layer's raw links. Argument: `concept_id`
(required). Outgoing links come from the resolved body; incoming links are
gathered from every concept elsewhere in the cascade that points back at this
one.

## Why `read_file` carries provenance, not just content {#why-provenance}

An agent that only got the merged text back would have no way to weight what
it's reading — a Company policy and an unreviewed Personal draft would look
identical. `read_file` deliberately returns enough structure
(`contributors`, `frontmatterProvenance`, `sourceLayer` per section) that an
agent can decide for itself how much to trust a given section, and can
surface a conflict to a human instead of silently picking one side.

## Cascade mode vs. legacy mode {#cascade-vs-legacy}

`mcp-server.mjs` accepts either a manifest (cascade mode, any number of
layers with any sources) or an explicit two-layer flag pair (legacy mode,
`okf-local` only):

```bash
node mcp-server.mjs --manifest layers.json
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared
```

Legacy mode exists for the simplest case — two local bundles, no `mcp`
sources — without requiring a manifest file at all.

## Next {#next}

- `architecture/conflicts-and-provenance.md` — the fields `read_file`
  attaches when layers disagree
- `architecture/the-manifest-and-trust-boundary.md` — what the server
  actually spawns when a layer's `source` is `mcp`
- `architecture/layers-and-precedence.md` — the precedence rules every tool
  resolves through
