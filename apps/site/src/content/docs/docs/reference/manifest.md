---
title: layers.json manifest
description: Layer names, levels, and sources — the complete manifest schema.
---

The manifest is a single JSON file that declares your layer stack. Every command
that resolves knowledge (`resolver.mjs`, `mcp-server.mjs`, `write.mjs`) is pointed
at one with `--manifest`. It is the one file that defines what layers exist, in
what order they take precedence, and where each layer's knowledge comes from.

## Schema

```json
{
  "layers": [
    { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
    { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
    { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
  ]
}
```

The top-level object has one key, `layers`: an ordered array of layer objects.

| Field | Required | Applies to | Meaning |
|-------|----------|------------|---------|
| `name` | yes | all | Layer identifier. Used in provenance (`sourceLayer`, `contributors`) and as the `layer` argument to `read_file`. |
| `level` | yes | all | Precedence. Higher wins per section. Personal is 3, Team is 2, Company is 0 by convention, but any integer works. |
| `source` | no | all | `okf-local` (default when omitted) or `mcp`. |
| `path` | for `okf-local` | `okf-local` | Directory of the OKF markdown bundle. |
| `command` | for `mcp` | `mcp` | Executable to spawn as a stdio MCP server. |
| `args` | for `mcp` | `mcp` | Argument array passed to `command`. |

## Precedence is by level

When a concept exists in more than one layer, the resolver merges it per section:
the highest `level` that speaks to a given section wins that section, and everything
else is inherited from below. Levels are integers you choose — higher is more
authoritative. Precedence is decided by level alone: two layers at the same level
keep the first one listed.

See [Merge semantics](/docs/concepts/merge-semantics) and
[Layer cake](/docs/concepts/layer-cake) for how precedence plays out across sections.

## Source types

A layer's `source` decides how its knowledge is loaded. Both are read through the
same adapter interface, so they stitch into one effective graph.

### `okf-local` (default)

An [OKF](/docs/concepts/okf-bundles) bundle: a directory of markdown files with YAML
frontmatter. The only required frontmatter field is `type`. Point `path` at the
directory.

```json
{ "name": "team", "level": 2, "source": "okf-local", "path": "~/kb-team" }
```

When `source` is omitted, `okf-local` is assumed:

```json
{ "name": "team", "level": 2, "path": "~/kb-team" }
```

### `mcp`

A foreign knowledge graph reached over a stdio MCP server. ContextCake spawns
`command` with `args`, speaks MCP to it, and translates its responses into OKF at
read time — so a graph that was never OKF stitches in alongside your local bundles.

```json
{ "name": "company", "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
```

See [Foreign MCP sources](/docs/guides/foreign-mcp-sources) for the adapter
contract and `examples/mock-mcp-source/server.mjs` for a runnable foreign source.

## How paths resolve

`path` and any relative `args` (those starting with `./` or `../`) resolve relative
to the manifest file's own directory — not the current working directory. A manifest
at `~/config/layers.json` with `"path": "kb-team"` reads `~/config/kb-team`. Absolute
paths and non-relative `args` are passed through unchanged. This makes a manifest
portable: keep it next to the bundles it points at and it works from anywhere.

## The trust boundary

An `mcp` layer runs `command` with `args` exactly as written. A manifest you did not
author can therefore execute arbitrary commands as your user the moment you resolve
against it. Treat the manifest the way you treat any MCP client config: only point
`--manifest` at files you trust. Read [The trust boundary](/docs/concepts/trust-boundary)
before pointing a manifest at sources you didn't write.

## The bundled demo manifest

`apps/playground/manifest.json` is the three-layer, all-`okf-local` stack used by the
docs examples and the playground. The layers deliberately disagree so the merge and
conflict surfacing are visible:

```json
{
  "layers": [
    { "name": "personal", "level": 3, "path": "demo-layers/personal" },
    { "name": "team",     "level": 2, "path": "demo-layers/team" },
    { "name": "company",  "level": 0, "path": "demo-layers/company" }
  ]
}
```

Resolve a concept against it:

```bash
node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
```

## Related

- [CLI](/docs/reference/cli) — every command that takes `--manifest`
- [MCP tools](/docs/reference/mcp-tools) — serving a manifest to an agent
- [Your first cascade](/docs/getting-started/first-cascade) — build your own manifest
