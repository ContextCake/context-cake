---
title: The trust boundary
description: The manifest can spawn commands. Only point ContextCake at manifests you trust.
---

The [manifest](/docs/reference/manifest) is a trust boundary. Read this before you
point ContextCake at a manifest you did not write.

:::caution[The manifest can run arbitrary commands]
A layer with `"source": "mcp"` causes ContextCake to spawn its `command` with its
`args` **as your user**. A manifest you did not author can run arbitrary commands on
your machine. Only point `--manifest` at configs you wrote or trust — the same model
as any MCP client config.
:::

## Why an `mcp` layer runs a command

A [foreign MCP source](/docs/guides/foreign-mcp-sources) is a knowledge graph reached
over a stdio MCP server. To read it, ContextCake spawns that server as a child process
and talks to it over stdin/stdout. The `command` and `args` for that process come
straight from the manifest:

```json
{ "name": "company", "level": 0, "source": "mcp",
  "command": "node", "args": ["./company-graph-server.mjs"] }
```

Nothing sandboxes that process. It runs with your user's permissions. If the manifest
says `"command": "sh", "args": ["-c", "..."]`, that is what gets executed. This is the
same as configuring any MCP client — the config that names a server is trusted to name
a safe one.

## `okf-local` layers only read files

An [`okf-local` layer](/docs/concepts/okf-bundles) is different. It is a directory of
markdown on disk, and ContextCake only reads those files. It spawns no process and
runs no command. A manifest built entirely from `okf-local` layers cannot execute
anything — it can only cause file reads under the paths it names.

The command-execution risk is specific to `mcp` layers. When you audit a manifest, the
layers to scrutinize are the ones with `"source": "mcp"`.

## The rule

**Only trusted manifests.** Point `--manifest` at a config you wrote, or one from a
source you trust the way you would trust an MCP client config. Treat an untrusted
manifest the way you would treat an untrusted shell script — because for `mcp` layers,
that is effectively what it is.

## Access control otherwise is free

Beyond command execution, access is governed by repo membership. Each
[`okf-local` layer is a git repo](/docs/concepts/layer-cake); if you can clone it, you
can read it, and if you cannot, it never contributes to your resolution. There is no
separate ACL layer to configure — the boundary you already enforce on repos is the
boundary on knowledge.

## Next

- [Foreign MCP sources](/docs/guides/foreign-mcp-sources) — configuring an `mcp` layer safely
- [Manifest reference](/docs/reference/manifest) — every layer field
- [Connect an agent (MCP)](/docs/getting-started/connect-an-agent) — wiring the resolved graph into an agent
