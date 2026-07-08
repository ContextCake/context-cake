---
type: tool-guide
updated: 2026-07-08
---

# Using ContextCake with Claude Code {#using-with-claude-code}

Two ways to give Claude Code the resolved cascade: register the live MCP
server (Claude can read and search the graph at runtime), or hand it this
pack as static context (Claude reads the architecture and conventions, no
running process required). Use both — they answer different questions.

## Option 1: register the MCP server {#register-the-mcp-server}

`mcp-server.mjs` is a dependency-free stdio MCP server. Register it with
absolute paths, since Claude Code spawns the process from its own working
directory:

```bash
claude mcp add contextcake -- node /ABS/PATH/mcp-server.mjs --manifest /ABS/PATH/layers.json
```

No manifest yet, or just trying it out — point at the bundled demo instead:

```bash
claude mcp add contextcake -- node /ABS/PATH/mcp-server.mjs --manifest /ABS/PATH/apps/playground/manifest.json
```

Once registered, Claude has four tools: `search`, `read_file`, `list_concepts`,
`get_links`. Ask it something like "what does the team layer say about our
primary database, and does that conflict with company policy?" — Claude calls
`search` or `read_file` and reasons over the returned `sourceLayer` and
`conflicts` fields instead of guessing.

> **Caution:** the manifest is a trust boundary. A layer with `"source": "mcp"`
> spawns its `command` with `args` as your user. Only register a manifest you
> trust — same model as any other MCP client config.

## Option 2: install this pack as static context {#install-this-pack-as-static-context}

This context pack (the directory these files live in) is itself meant to be
read as context, independent of a running server. Two ways to give it to
Claude Code:

- **Drop it in the repo.** Copy the pack directory into your project (for
  example `.claude/context/contextcake/`) so Claude Code picks it up as part
  of the working tree it already reads.
- **Install as a Claude Code plugin.** Package the pack's `PACK.yaml` and
  module directories following Claude Code's plugin skill-content
  conventions, then reference it from your plugin marketplace or local
  plugin config.

Static context answers "how does ContextCake work and how do I use it here" —
the MCP server answers "what does my resolved graph currently say." Most
setups want the MCP server for live queries and this pack (or its
`overview/` and `architecture/` modules at minimum) for the mental model.

## Verifying the connection {#verifying-the-connection}

```bash
claude mcp list
```

Confirms `contextcake` is registered. Then ask Claude to call `list_concepts`
— if you get back concept IDs and contributing layers, the server is live and
resolving.

## Next {#next}

- `tool-guides/pointing-an-agent-at-the-resolved-graph.md` — the same setup, generalized to any MCP client
- `getting-started/connect-an-ai-agent.md` — the underlying server flags and tool schemas
