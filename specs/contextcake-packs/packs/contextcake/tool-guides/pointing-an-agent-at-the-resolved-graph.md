---
type: tool-guide
updated: 2026-07-08
---

# Pointing any agent at the resolved graph {#pointing-any-agent-at-the-resolved-graph}

`mcp-server.mjs` speaks plain MCP over stdio. Nothing about it is
Claude-specific — any MCP-capable client (Cursor, a custom agent harness, your
own MCP client library) can spawn it the same way and get the same resolved
cascade. This guide is the tool-agnostic version.

## Spawning the server {#spawning-the-server}

Every MCP client config reduces to a command and arguments:

```json
{ "command": "node", "args": ["/ABS/PATH/mcp-server.mjs", "--manifest", "/ABS/PATH/layers.json"] }
```

Use absolute paths — the client spawns the process from its own working
directory, not the manifest author's. The server identifies itself over the
MCP `initialize` handshake as `contextcake`.

> **Caution:** the manifest named in `--manifest` is a trust boundary: a layer
> with `"source": "mcp"` spawns its own `command` with `args` as your user.
> Only point any client at a manifest you trust.

## The four tools {#the-four-tools}

| Tool | Input | Returns |
|------|-------|---------|
| `search` | `query`, optional `limit` | One entry per matching concept, with a snippet and contributing layers |
| `read_file` | `concept_id`, optional `layer` | The resolved effective concept: merged sections, frontmatter, provenance, per-section `conflicts`. With `layer`, one layer's raw unmerged concept instead. |
| `list_concepts` | optional `type` filter | Every effective concept ID with its contributing layers |
| `get_links` | `concept_id` | Outgoing and incoming links, resolved against the effective graph |

These are the only four surfaces an agent needs — search to find a concept,
`read_file` to read it resolved, `list_concepts` to enumerate what exists,
`get_links` to walk the graph.

## Weight facts by provenance, not just content {#weight-facts-by-provenance}

Every `read_file` response includes fields an agent should reason over before
treating a value as fact:

- **`contributors`** — every layer holding a version of this concept, with
  its `level` and `updated` date. A `personal` note (level 3) outranks
  `company` (level 0) in the merge, but that doesn't make it more *true* —
  it's one person's view, current as of one date.
- **`frontmatterProvenance`** — which layer set each frontmatter field.
- **Per-section `sourceLayer`** — the winning layer for that section
  specifically. Different sections of the same concept can be won by
  different layers.

A well-behaved agent treats layer level as precedence for which answer to
surface first, not as a proxy for confidence. Company policy on a compliance
question should usually outrank a personal note even if that's not how the
manifest ranks levels for other purposes — build that judgment into the
agent's prompt, not into the engine (the engine only knows numeric levels).

## Respect surfaced conflicts {#respect-surfaced-conflicts}

When a section carries a `conflicts` array, the resolver is telling you
something specific: layers disagree, and it picked a primary answer by
precedence, not by adjudicating who's right. The correct agent behavior is
usually one of:

- State the primary answer, then note the disagreement and who holds it
  (name the layer and its `updated` date) — especially for anything
  consequential (compliance, security, financial decisions).
- If the conflict looks like plain staleness (the losing layer is
  conspicuously older with no rationale), say so, but don't silently resolve
  it — resolution is a human action in ContextCake, not something an agent
  should do unprompted by rewriting a source file.
- Never merge or average conflicting values into a new answer that appears
  nowhere in any layer.

## Next {#next}

- `tool-guides/using-with-claude-code.md` — the Claude Code specific registration steps
- `getting-started/connect-an-ai-agent.md` — starting the server and its flags
