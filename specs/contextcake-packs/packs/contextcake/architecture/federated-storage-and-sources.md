---
type: architecture
updated: 2026-07-08
---

# Federated storage and sources {#federated-storage-and-sources}

ContextCake does not centralize your knowledge. Storage stays **federated** —
each layer keeps its knowledge exactly where it already lives, and ContextCake
reads it through a uniform adapter at request time. There is no import step,
no copy, no shared database. Delete ContextCake and every layer's knowledge is
untouched.

## The `source` seam {#the-source-seam}

Every layer in the manifest declares a `source`. That field decides how the
layer's knowledge gets loaded, and it is the one seam that lets ContextCake
stitch together things that were never the same format:

```json
{ "name": "team", "level": 2, "source": "okf-local", "path": "~/kb-team" }
```

Two source kinds exist today:

- **`okf-local`** — a directory (typically a git repo) of OKF markdown files
  on disk. This is the default: a layer that omits `source` entirely is
  treated as `okf-local`.
- **`mcp`** — a foreign knowledge graph reached over a stdio MCP server. Its
  responses are **translated into OKF at read time**, so a graph that was
  never OKF stitches in alongside your native bundles as if it always had
  been.

Both kinds are read through the same adapter interface, so the resolver never
needs to know or care which one it's talking to.

## Why translation happens at read time {#translation-at-read-time}

An `mcp` layer does not get pre-converted or cached into OKF on disk. Every
read spawns (or reuses) the MCP connection, queries the foreign server, and
maps its response shape into OKF frontmatter and sections in memory, for that
one request. This keeps ContextCake honest about owning no source of truth —
the foreign graph stays the foreign graph's problem to store and version; the
translation is a lens, not a migration.

The practical effect: an `okf-local` layer changes are visible as soon as you
edit the file. An `mcp` layer's freshness depends entirely on what the foreign
server currently returns.

## The adapter files {#the-adapter-files}

Three files implement this seam:

| File | Role |
|------|------|
| `sources/okf-local.mjs` | Reads an OKF bundle from disk — the default adapter |
| `sources/mcp.mjs` | Spawns a foreign stdio MCP server, translates its responses into OKF |
| `sources/index.mjs` | Builds the right adapter for each layer from the manifest |

`sources/index.mjs` is the factory: given a manifest, it walks `layers[]`,
looks at each layer's `source` (defaulting to `okf-local`), and constructs the
matching adapter with that layer's `name` and `level` attached. Everything
downstream — the resolver, the MCP server, the CLI — talks to the resulting
adapters through the same shape, never to raw files or raw MCP responses
directly.

## Why this matters {#why-this-matters}

Federation is the point, not an implementation detail. Your company's
knowledge graph almost certainly predates ContextCake and lives behind its own
tool with its own access model. Federated storage means ContextCake can sit on
top of that reality instead of demanding you migrate into it — you write one
`mcp` adapter for a foreign system once, and every layer that uses it stitches
in for free.

See `architecture/layers-and-precedence.md` for how the resolver combines what
each source returns, and `architecture/the-manifest-and-trust-boundary.md` for
why an `mcp` source is also a trust decision, not just a config option.
