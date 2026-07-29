---
title: Manifest reference
description: Profiles, project mappings, layer sources, precedence, and compatibility.
---

The manifest is a single local JSON file that declares ContextCake's profiles,
project mappings, layer stacks, and Pack assignments. Every command that resolves
knowledge is pointed at one with `--manifest`.

ContextCake still reads the original flat `layers` shape without rewriting it.
The Project Profiles rollout adds a canonical v2 shape with a required `default`
profile. The shared manifest and Pack code understand v2 now; automatic profile
selection in `resolver.mjs` and `mcp-server.mjs` arrives in the next implementation
slice. Until that wiring ships, keep agent-facing manifests flat rather than
manually converting them.

## Current flat schema

```json
{
  "layers": [
    { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
    { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
    { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
  ]
}
```

The main top-level key is `layers`, an array of layer objects. The local Pack manager
may also maintain a `packs` registry of installed versions and assignments. That
registry is bookkeeping for rollback; resolution reads only explicit layer entries.

The shared profile selector treats a flat manifest as an in-memory virtual profile
with id `default`. Selection does not alter the file. Creating the first additional
profile is the deliberate migration point described below.

## Manifest v2: Project Profiles

Canonical v2 moves every runnable layer into one profile and stores local project
folder mappings separately:

```json
{
  "profiles": {
    "default": {
      "label": "Default",
      "layers": [
        { "name": "personal", "level": 3, "source": "files", "path": "/Users/you/Notes" }
      ]
    },
    "payments": {
      "label": "Payments",
      "layers": [
        { "name": "repo", "level": 3, "source": "github", "repo": "acme/payments", "paths": ["docs/**"] },
        { "name": "team-pack", "level": 0, "source": "okf-local", "path": "packs/team/1.0.0" }
      ],
      "pendingSources": []
    }
  },
  "projects": {
    "/Users/you/Code/payments": "payments"
  },
  "packs": {}
}
```

The v2 rules are intentionally strict:

- `profiles.default` is required and cannot be deleted.
- Profile ids are stable lowercase slugs of at most 63 characters. Changing a
  visible `label` does not change the id.
- Each profile owns a complete `layers` array. Layer names need to be unique only
  within that profile.
- `projects` maps absolute, machine-local folders to profile ids. The paths are
  never uploaded by settings sync.
- `pendingSources` holds synced descriptors that are incomplete or not yet
  trusted on this machine. The later profile UI will present them as repair tasks;
  the engine never treats them as runnable layers.
- Canonical v2 has `profiles` and no top-level `layers`.

### Selection order

Profile-aware commands use one deterministic order:

1. An explicit `--profile <id>` wins.
2. Otherwise, the deepest canonical project folder containing the process working
   directory wins. Matching uses path segments, not a raw string prefix.
3. With no match, the required `default` profile wins.

An explicit or matched unknown profile fails closed. It never falls through to
unrelated default context. Symlink aliases are resolved to real paths; two equally
specific aliases that name different profiles are a configuration error.

### Migration and transitional manifests

Existing flat manifests are not migrated on read. Creating the first additional
profile performs one locked transaction:

1. Re-read and validate the latest manifest.
2. Write and verify a mode-`0600` backup whose filename contains a UTC timestamp
   and SHA-256 of the original bytes.
3. Move the exact flat layer array to `profiles.default.layers`.
4. Convert default-stack Pack assignments to profile `default` and quarantine
   incomplete synced source descriptors in `pendingSources`.
5. Validate the complete candidate and atomically replace the manifest.

Some current settings-sync and Pack combinations can contain both top-level
`layers` and profile metadata. ContextCake recognizes that as a transitional
shape and continues running the flat stack until explicit normalization. General
writers reject newly created split-brain documents; only compatibility operations
may update a shipped transitional file.

Profile and source mutations share one adjacent lock file, so concurrent Pack,
source, mapping, and profile operations cannot overwrite one another. Pack
assignment, active version, precedence, origin, and layer references are validated
as one contract before an atomic write.

### Cache identity

Profile-aware cache entries use an opaque SHA-256 fingerprint derived from the
profile id and canonical source configuration. The fingerprint includes source
kind and name plus its local root, repository/ref/path selection, endpoint, MCP
command/arguments, and adapter options as applicable. Raw local paths do not appear
in the cache namespace. Equal layer names in two profiles, renamed sources, and the
same repository at different refs therefore cannot share cached content.

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
authoritative. When two contributors have the same level, the most recently
updated contributor wins that horizontal tie; array order is not an extra
precedence rule.

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
rather than the repo's last push, so staleness is per document. An explicit OKF
section date still wins; an OKF frontmatter date fills otherwise-undated sections
before the commit date is used.

`paths` accepts `*` (within one path segment), `?`, and `**` (spanning segments).
Setting it replaces the defaults rather than adding to them. Only `.md`, `.mdx`,
and `.txt` files are indexed.

Reads are read-only and degrade rather than fail: if GitHub is unreachable, rate
limited, or the token lacks access, the layer warns on stderr and the remaining
layers still resolve. Add a `cache` block — a search sweeps every concept in
every layer, and the cache is what keeps that inside your API rate limit.

GitHub may truncate very large recursive tree responses. ContextCake refuses to
index that partial response as if it were complete; it serves the last complete
cached index when available, or resolves without that layer until a complete tree
can be read. The source Sync action clears its TTL and immediately refreshes this
remote index while preserving the separate clone-and-pull behavior of local Git
sources.

#### Credentials

The manifest never holds a token. `auth` may only *name* one:

- `"keychain:<alias>"` — the desktop app resolves the alias from the macOS
  Keychain and injects the secret at build time. The engine never opens a keychain.
- `{"tokenEnv": "NAME"}` — for CLI and CI runs, read from that environment variable.

The object form must contain exactly the one `tokenEnv` field. Extra fields and
every other shape are rejected outright, so a raw credential cannot hide beside
an otherwise-valid reference. A repository you can read without a token needs no
`auth` at all; an alias with nothing injected reads anonymously rather than failing.

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

The same applies to credentials. A `github` layer may set `apiBase` to reach GitHub
Enterprise — which means a manifest that pairs a hostile `apiBase` with a legitimate
`auth` alias would send that credential to a host of its choosing. The alias names a
secret the *app* holds, so the manifest never sees the token itself, but it does decide
where the token is sent. Review `apiBase` and `auth` together on any manifest you did
not write, and prefer omitting `apiBase` entirely unless you genuinely run Enterprise.

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
delete another layer. In v2, every Pack assignment names its profile explicitly;
the same retained immutable version may be attached to more than one profile.

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
