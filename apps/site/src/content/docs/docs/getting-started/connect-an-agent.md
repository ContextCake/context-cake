---
title: Connect an agent (MCP)
description: Point Claude or any MCP client at the resolved cascade.
---

Point Claude or any MCP client at the resolved cascade.

## Start the server

`mcp-server.mjs` is a dependency-free stdio MCP server. It resolves every read
through the same cascade engine as the CLI — section/field merge, precedence,
provenance, per-section conflicts — and exposes the result as MCP tools.

Point it at the bundled demo:

```bash
node mcp-server.mjs --manifest apps/playground/manifest.json
```

Or use the legacy two-layer form, no manifest file required:

```bash
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared
```

`--help` prints usage for both forms.

:::caution
The manifest is a trust boundary. A layer with `"source": "mcp"` spawns its
`command` with `args` as your user. Only point `--manifest` at a config you
trust — same model as any MCP client config.
:::

## Register it with Claude Code

Use absolute paths — MCP clients spawn the server from their own working
directory, not yours:

```bash
claude mcp add contextcake -- node /ABS/PATH/mcp-server.mjs --manifest /ABS/PATH/apps/playground/manifest.json
```

The server identifies itself over the MCP `initialize` handshake as
`contextcake`. Any MCP-compatible client — not just Claude Code — can spawn it
the same way: `command` is `node`, `args` are the script path and flags.

## Tools

| Tool | What it returns |
|------|-------|
| `search` | One entry per matching concept ID, with a snippet and the layers that contribute to it. Takes `query` and an optional `limit`. |
| `read_file` | The resolved effective concept: merged sections, frontmatter, provenance, and per-section conflicts. Takes `concept_id`; pass `layer` to instead read one layer's raw, unmerged concept. |
| `list_concepts` | Every effective concept ID across the cascade with its contributing layers. Takes an optional `type` filter. |
| `get_links` | Outgoing and incoming links for a concept, resolved against the effective graph. Takes `concept_id`. |

## Reading a resolved concept as an agent

Call `read_file` with `concept_id: "decisions/primary-db"` against the demo
manifest and the response carries the same shape the CLI prints: `contributors`
(every layer that has this concept, with its updated date),
`frontmatterProvenance` (which layer set each frontmatter field), and sections
each tagged with the `sourceLayer` that won them. Where layers disagree on a
section, the losing layers' content rides along as that section's `conflicts`
array instead of being dropped.

This is what makes the resolved graph safe for an agent to read directly: it
can quote the winning value as authoritative, but it can also see *that*
there's a live disagreement, who holds each position, and when each side was
last updated — so it can flag the disagreement to a human instead of silently
picking a side, or weight a personal-layer note lower than a company-layer
policy when they conflict.

## Next

- [MCP tools reference](/docs/reference/mcp-tools) — full input/output schemas
  for all four tools
- [The trust boundary](/docs/concepts/trust-boundary) — what spawning an `mcp`
  layer's command means for the machine running the server
