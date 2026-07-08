---
type: architecture
updated: 2026-07-08
---

# The manifest and trust boundary {#the-manifest-and-trust-boundary}

`layers.json` — the manifest — is the one file that defines what layers
exist, in what order they take precedence, and where each layer's knowledge
comes from. Every command that resolves knowledge (`resolver.mjs`,
`mcp-server.mjs`, `write.mjs`) is pointed at one with `--manifest`.

## Shape {#shape}

```json
{
  "layers": [
    { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
    { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
    { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
  ]
}
```

One top-level key, `layers`: an ordered array of layer objects.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Layer identifier, used in provenance and as the `layer` argument to `read_file` |
| `level` | yes | Precedence — higher wins per section (any integer; 3/2/0 is convention, not a rule) |
| `source` | no | `okf-local` (default) or `mcp` |
| `path` | for `okf-local` | Directory holding the OKF bundle |
| `command` / `args` | for `mcp` | Executable and arguments to spawn as a stdio MCP server |

`path` and any relative `args` (starting with `./` or `../`) resolve
relative to the manifest file's own directory, not the current working
directory — so a manifest stays portable if you keep it next to the bundles
it points at.

## Why the manifest is a trust boundary {#why-a-trust-boundary}

A layer with `"source": "mcp"` causes ContextCake to spawn `command` with
`args` **as your user**. Nothing sandboxes that process — it runs with full
user permissions, exactly as if you had typed the command yourself. If the
manifest says:

```json
{ "name": "company", "level": 0, "source": "mcp", "command": "sh", "args": ["-c", "..."] }
```

that shell command runs, unreviewed, the moment something resolves against
this manifest. A manifest you did not author can therefore execute arbitrary
commands on your machine.

This is not a hypothetical edge case bolted onto the design — it is the same
model as any MCP client config (Claude Desktop, Claude Code, or any other
tool that spawns MCP servers from a config file). Treat `layers.json` with
the same suspicion you'd treat an unfamiliar MCP config or an unfamiliar
shell script someone handed you.

## `okf-local` layers only read files {#okf-local-only-reads-files}

The risk is specific to `mcp` layers. An `okf-local` layer is a directory of
markdown on disk — ContextCake only reads those files under `path`. It spawns
no process and runs no command. A manifest built entirely from `okf-local`
layers cannot execute anything; the worst it can do is point you at files you
didn't expect to read.

When you audit a manifest before trusting it, the layers to scrutinize are
the ones with `"source": "mcp"` — check `command` and `args` specifically.

## The rule {#the-rule}

**Only point `--manifest` at configs you wrote or trust.** Same model as any
MCP client config: the config that names a server is trusted to name a safe
one. This applies everywhere a manifest is consumed — `resolver.mjs`,
`mcp-server.mjs`, `write.mjs` — not just the MCP server.

## Next {#next}

- `architecture/federated-storage-and-sources.md` — what `okf-local` and
  `mcp` actually do once trusted
- `architecture/the-mcp-server.md` — the server that reads this manifest to
  serve agents
- `architecture/layers-and-precedence.md` — how `level` in this file drives
  resolution
