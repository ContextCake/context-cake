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

The main top-level key is `layers`, an ordered array of layer objects. The local Pack
manager may also maintain a `packs` registry of installed versions and assignments. That
registry is bookkeeping for rollback; the resolver reads only the explicit layer entries.

| Field | Required | Applies to | Meaning |
|-------|----------|------------|---------|
| `name` | yes | all | Layer identifier. Used in provenance (`sourceLayer`, `contributors`) and as the `layer` argument to `read_file`. |
| `level` | yes | all | Precedence. Higher wins per section. Personal is 3, Team is 2, Company is 0 by convention, but any integer works. |
| `source` | no | all | `okf-local` (default when omitted), `files`, `github`, or `mcp`. |
| `path` | for `okf-local` / `files` | `okf-local`, `files` | Directory of the OKF bundle or existing document folder. |
| `command` | for `mcp` | `mcp` | Executable to spawn as a stdio MCP server. |
| `args` | for `mcp` | `mcp` | Argument array passed to `command`. |
| `repo` | for `github` | `github` | `owner/name` of the repository to read. |
| `ref` | no | `github` | Branch or tag to read. Defaults to the repository's default branch. |
| `paths` | no | `github` | Glob selectors for which files become concepts. Replaces the defaults when set. |
| `auth` | no | `github` | A credential *reference* — `"keychain:<alias>"` or `{"tokenEnv": "NAME"}`. Never a token. |
| `cache` | no | all | `{ "ttlSeconds": N, "dir": "..." }`. Strongly recommended for `github`. |

## Precedence is by level

When a concept exists in more than one layer, the resolver merges it per section:
the highest `level` that speaks to a given section wins that section, and everything
else is inherited from below. Levels are integers you choose — higher is more
authoritative. Precedence is decided by level alone: two layers at the same level
keep the first one listed.

See [Merge semantics](/docs/concepts/merge-semantics) and
[Layer cake](/docs/concepts/layer-cake) for how precedence plays out across sections.

## Source types

A layer's `source` decides how its knowledge is loaded. Each is read through the
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

### `files`

A local folder of existing Markdown, MDX, or plain-text documents. This is the
best starting point for repository docs, an Obsidian vault, or a Markdown wiki:
no ContextCake-specific frontmatter is required. Plain Markdown uses its first
`#` heading as the title and its `##` headings as sections; files that already
have OKF frontmatter keep their full structured behavior.

```json
{ "name": "work-notes", "level": 3, "source": "files", "path": "/Users/you/Documents/Obsidian" }
```

### `github`

A repository read directly over the GitHub API — no clone, no checkout. The
markdown your team already keeps in the repo becomes a layer: by default
`CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/**`, and `.context/**`. Documents
parse by exactly the same rules as `files`, so a `CLAUDE.md` on GitHub and one on
disk merge section-for-section instead of splitting into parallel sections.

```json
{
  "name": "payments-repo",
  "level": 3,
  "source": "github",
  "repo": "acme/payments",
  "paths": ["CLAUDE.md", "docs/**"],
  "auth": "keychain:github",
  "cache": { "ttlSeconds": 900 }
}
```

Concept ids are repo-qualified — `acme/payments/docs/runbook` — so several repos
can be layered without colliding. Section dates come from each file's last commit
rather than the repo's last push, so staleness is per document.

`paths` accepts `*` (within one path segment), `?`, and `**` (spanning segments).
Setting it replaces the defaults rather than adding to them. Only `.md`, `.mdx`,
and `.txt` files are indexed.

Reads are read-only and degrade rather than fail: if GitHub is unreachable, rate
limited, or the token lacks access, the layer warns on stderr and the remaining
layers still resolve. Add a `cache` block — a search sweeps every concept in
every layer, and the cache is what keeps that inside your API rate limit.

#### Credentials

The manifest never holds a token. `auth` may only *name* one:

- `"keychain:<alias>"` — the desktop app resolves the alias from the macOS
  Keychain and injects the secret at build time. The engine never opens a keychain.
- `{"tokenEnv": "NAME"}` — for CLI and CI runs, read from that environment variable.

Any other shape is rejected outright, so a raw credential cannot sit in a manifest
by accident. A repository you can read without a token needs no `auth` at all; an
alias with nothing injected reads anonymously rather than failing.

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

## Pack-managed layers

A Pack installed with `pack.mjs` is an ordinary `okf-local` base layer with an `origin`
that records the Pack identity and active version:

```json
{
  "name": "pack-contextcake",
  "level": 0,
  "source": "okf-local",
  "path": "packs/contextcake/0.1.0",
  "origin": "pack:contextcake@0.1.0"
}
```

Do not edit installed Pack directories. Put personal or team changes in a separate,
higher-precedence layer. Updates switch only the Pack-managed layer path; rollback points
it at a retained version; removal detaches it. None of those operations overwrite or
delete another layer.

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
