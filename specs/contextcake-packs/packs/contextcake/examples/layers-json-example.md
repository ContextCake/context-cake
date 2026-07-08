---
type: example
updated: 2026-07-08
---

# A real `layers.json`, field by field {#a-real-layers-json}

The manifest is the one file that declares your whole cascade: which
layers exist, their precedence, and how to reach each one. Here is a
realistic three-layer manifest — personal and team as local bundles,
company reached over MCP — with every field explained.

## The manifest {#the-manifest}

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

## Field by field {#field-by-field}

**`name`** — a label used in output (`sourceLayer`, `contributors`,
`conflicts[].layer`) so you can see which layer answered or dissented. Not
used for precedence.

**`level`** — the number that actually decides who wins. Higher wins, per
section, when two layers define the same concept. Here personal (3) beats
team (2) beats company (0). Levels are yours to set — the 3/2/0 spread is a
convention, not a hardcoded rule, and you could run a four-layer stack with
different numbers if your org needs it. There is no same-level tiebreak, so
give each layer a distinct level.

**`source`** — `okf-local` or `mcp`. Defaults to `okf-local` when omitted,
so the personal and team lines above could drop `"source": "okf-local"`
entirely and behave the same; it's written out here for clarity.

**`path`** (`okf-local` only) — the directory holding the bundle. Personal
and team here are two separate git repos on disk, each with its own access
control: repo membership is read access.

**`command` / `args`** (`mcp` only) — exactly what gets spawned to reach
this layer. The company layer above runs `node ./company-graph-server.mjs`
as a child process and talks MCP to it over stdio. No separate transport
config exists — this is the whole story.

## What's not in this file {#whats-not-in-this-file}

No merge rules, no conflict-resolution logic, no auth tokens. Precedence is
just `level`. Merge behavior lives in the resolver and in each concept's own
`{#anchor}` structure, not in the manifest. If a layer needs credentials to
reach a real backend, that belongs in the spawned command's own environment
or config — not in `layers.json`, which is not a secrets file.

## The trust boundary {#the-trust-boundary}

Anyone who can edit this file can make your `mcp` layers run arbitrary
commands as you — `command` and `args` are executed, not sandboxed. Only
point `--manifest` at a file you wrote or explicitly trust, the same way
you'd vet any MCP client config before pointing a tool at it.

## Next {#next}

- `use-cases/foreign-mcp-sources.md` — what actually happens when the
  company layer above gets queried
- `examples/resolved-output-example.md` — a `read_file` call against a
  concept spanning all three of these layers
