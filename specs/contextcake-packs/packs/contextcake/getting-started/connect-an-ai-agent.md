---
type: guide
updated: 2026-07-08
---

# Connect an AI agent {#connect-an-ai-agent}

`mcp-server.mjs` is a dependency-free stdio MCP server. It resolves every read
through the same cascade engine as the CLI — section/field merge, precedence,
provenance, per-section conflicts — and exposes the result as MCP tools.

## Start the server {#start-the-server}

Cascade mode, against a manifest:

```bash
node mcp-server.mjs --manifest layers.json
```

Legacy two-layer mode, no manifest file required:

```bash
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared
```

`--help` prints usage for both forms.

> **Caution:** the manifest is a trust boundary. A layer with `"source": "mcp"`
> spawns its `command` with `args` as your user. Only point `--manifest` at a
> config you trust — same model as any MCP client config.

## Register it as an MCP server {#register-it-as-an-mcp-server}

Use absolute paths — MCP clients spawn the server from their own working
directory, not yours. For Claude Code:

```bash
claude mcp add contextcake -- node /ABS/PATH/mcp-server.mjs --manifest /ABS/PATH/layers.json
```

The server identifies itself over the MCP `initialize` handshake as
`contextcake`. Any MCP-compatible client can spawn it the same way: `command`
is `node`, `args` are the script path and flags.

## What the agent gets {#what-the-agent-gets}

| Tool | What it returns |
|------|------------------|
| `search` | One entry per matching concept ID, with a snippet and the contributing layers. |
| `read_file` | The resolved effective concept: merged sections, frontmatter, provenance, per-section `conflicts`. Pass `layer` to instead read one layer's raw, unmerged concept. |
| `list_concepts` | Every effective concept ID across the cascade with its contributing layers. |
| `get_links` | Outgoing and incoming links for a concept, resolved against the effective graph. |

Every `read_file` response carries `contributors` (each layer with its
last-updated date), `frontmatterProvenance` (which layer set each frontmatter
field), and sections tagged with the `sourceLayer` that won them.

## Why this is safe for an agent to read directly {#why-this-is-safe}

Where layers disagree on a section, the losing layers' content rides along as
that section's `conflicts` array instead of being dropped. The agent can quote
the winning value as authoritative, but it can also see *that* there's a live
disagreement, who holds each position, and when each side was last updated —
so it can flag the disagreement to a human instead of silently picking a side,
or weight a personal-layer note lower than a company-layer policy when they
conflict.

## Try it against the demo {#try-it-against-the-demo}

```bash
node mcp-server.mjs --manifest playground/manifest.json
```

Then call `read_file` with `concept_id: "decisions/primary-db"` from your
agent — the bundled demo layers deliberately disagree on that concept, so
you'll see a populated `conflicts` array on the first try.

## Next {#next}

- `tool-guides/using-with-claude-code.md` — the same setup, Claude Code specific
- `tool-guides/pointing-an-agent-at-the-resolved-graph.md` — tool-agnostic consumption patterns
