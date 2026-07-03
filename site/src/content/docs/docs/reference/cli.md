---
title: CLI
description: Flags and output shapes for resolver, ingest, write, promote, and mcp-server.
---

Every tool is a standalone Node.js script run with `node <tool>.mjs`. The engine is
dependency-free, so there is nothing to install first. Each tool accepts `--help`
(`-h`) and prints its own usage. The examples below run against the bundled
[demo manifest](/docs/reference/manifest#the-bundled-demo-manifest),
`playground/manifest.json`.

## resolver.mjs

Resolves one OKF concept across the layer stack into an effective concept — section
merge, level precedence, provenance, and per-section conflicts — and prints it as
JSON.

```
node resolver.mjs --manifest <file> --concept <id>
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--manifest <file>` | yes | Path to the [layers manifest](/docs/reference/manifest). |
| `--concept <id>` | yes | Concept ID to resolve, e.g. `decisions/primary-db`. |
| `--help`, `-h` | no | Print usage and exit. |

```bash
node resolver.mjs --manifest playground/manifest.json --concept decisions/primary-db
```

Output is the effective concept: `contributors` (each layer with its level and
last-updated date), `frontmatter`, `frontmatterProvenance`, and `sections[]`, where
each section carries the `sourceLayer` that won it and an optional `conflicts` array
for dissenting layers. See [Merge semantics](/docs/concepts/merge-semantics).

## mcp-server.mjs

Runs the stdio MCP server that exposes the resolved cascade to AI agents. Runs in
cascade mode (a manifest) or the legacy two-layer mode (explicit personal + shared
directories).

```
node mcp-server.mjs --manifest <file>
node mcp-server.mjs --personal <dir> --shared <dir>
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--manifest <file>` | one mode | Cascade mode: resolve the full stack in the manifest. |
| `--personal <dir>` | one mode | Legacy mode: personal bundle directory (level 3). Use with `--shared`. |
| `--shared <dir>` | one mode | Legacy mode: shared bundle directory (level 0). Use with `--personal`. |
| `--help`, `-h` | no | Print usage and exit. |

Provide either `--manifest`, or both `--personal` and `--shared`.

```bash
node mcp-server.mjs --manifest playground/manifest.json
```

The server speaks MCP over stdin/stdout. See [MCP tools](/docs/reference/mcp-tools)
for the tools it exposes and [Connect an agent](/docs/getting-started/connect-an-agent)
for wiring it into a client.

## ingest.mjs

Classifies a list of normalized repo signal events through the context policy and
writes a dashboard-ready `signals.json` (signals plus per-repo coverage).

```
node ingest.mjs --events <file> --out <file>
```

| Flag | Required | Default | Meaning |
|------|----------|---------|---------|
| `--events <file>` | no | `mock-events.json` | Normalized event list to classify. |
| `--repos <file>` | no | `repos.json` | Repo config (owners, areas) for coverage summaries. |
| `--out <file>` | no | `control-surface/signals.json` | Where to write the signals output. |
| `--policy <file>` | no | `context-policy.json` | Classification rules. |
| `--demo` | no | — | Use the bundled `mock-events.json`. |
| `--help`, `-h` | no | — | Print usage and exit. |

```bash
node ingest.mjs --events mock-events.json --out control-surface/signals.json
```

The output feeds [write.mjs](#writemjs) and the control-surface dashboard. See
[The capture write path](/docs/guides/capture-write-path).

## write.mjs

Writes captured OKF concepts from an ingest `signals.json` into a target layer
bundle. `team_candidate` signals are written directly; `review_required` signals are
staged under `_review/` for human approval; `ignore` and `local` are skipped.

```
node write.mjs --signals <file> --manifest <file> --target-layer <name>
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--signals <file>` | yes | The `signals.json` produced by `ingest.mjs`. |
| `--manifest <file>` | yes | Manifest whose layers name the write targets. |
| `--target-layer <name>` | no | Layer to write into. Defaults to the highest level below 3 (team, company, etc.). |
| `--dry-run` | no | Report what would be written without touching disk. |
| `--help`, `-h` | no | Print usage and exit. |

```bash
node write.mjs --signals control-surface/signals.json --manifest playground/manifest.json --target-layer team --dry-run
```

See [The capture write path](/docs/guides/capture-write-path).

## promote.mjs

Copies one markdown concept from a personal OKF bundle into a shared bundle,
rewriting personal links and rebuilding the shared `index.md`. It works over two
**directories**, not a manifest.

```
node promote.mjs --personal <dir> --shared <dir> --file <concept-or-path>
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--personal <dir>` | yes | Source personal bundle directory. |
| `--shared <dir>` | yes | Destination shared bundle directory. |
| `--file <concept-or-path>` | yes | Concept ID or path to promote (`.md` optional). |
| `--branch <name>` | no | Branch name suggested by `--print-git`. Defaults to `promote/<concept-slug>` — `.md` dropped and every character outside `[a-zA-Z0-9._-]` (including `/`) collapsed to a hyphen, e.g. `decisions/primary-db` → `promote/decisions-primary-db`. |
| `--dry-run` | no | Print the planned operations and promoted content as JSON; write nothing. |
| `--print-git` | no | After writing, print suggested `git` commands to open a PR. |
| `--help`, `-h` | no | Print usage and exit. |

```bash
node promote.mjs --personal ~/kb-personal --shared ~/kb-team --file decisions/primary-db --print-git
```

See [Promoting concepts](/docs/guides/promoting-concepts).

## classify-context.mjs

Classifies a single repo or team signal event into `ignore`, `local`,
`team_candidate`, or `review_required`, and prints the classification as JSON. This
is the per-event core that `ingest.mjs` runs in batch.

```
node classify-context.mjs --event <file>
```

| Flag | Required | Meaning |
|------|----------|---------|
| `--event <file>` | one mode | Event JSON to classify. |
| `--demo` | one mode | Classify a bundled sample event instead. |
| `--policy <file>` | no | Classification rules. Defaults to `context-policy.json`. |
| `--help`, `-h` | no | Print usage and exit. |

Provide either `--event` or `--demo`.

```bash
node classify-context.mjs --demo
```

## Related

- [layers.json manifest](/docs/reference/manifest) — the file every `--manifest` flag points at
- [MCP tools](/docs/reference/mcp-tools) — what `mcp-server.mjs` exposes
- [Override syntax](/docs/reference/override-syntax) — controlling the merge from frontmatter
