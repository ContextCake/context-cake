---
title: MCP tools
description: search, read_file, list_concepts, get_links, find_captures, whats_new — request and response shapes.
---

`mcp-server.mjs` is a stdio MCP server that exposes the resolved cascade to AI
agents as one effective, read-time OKF graph. Reads resolve through the same
section/field merge as the CLI — level precedence, provenance, per-section
conflicts — over every source in the manifest.

## The read tools

The default server exposes six read-only tools:

| Tool | What it does |
|------|--------------|
| `search` | Full-text search across all layers; returns one entry per concept with contributing layers |
| `read_file` | Returns the resolved effective concept — section merge + provenance + per-section conflicts. Pass `layer` for a raw single-layer read. |
| `list_concepts` | All effective concept IDs with their contributing layers |
| `get_links` | Outgoing and incoming links, resolved against the effective graph |
| `find_captures` | Search recent team captures (unreviewed session findings: investigations, decisions, gotchas, artifacts), ranked by relevance × recency; each hit carries author, age, kind, and review status. Optional `kinds` filter. |
| `whats_new` | Captures and curated-concept changes since a `since` timestamp — session-start orientation |

## Capture tools (with `--capture`)

Running `mcp-server.mjs --capture` (team sync) adds two write tools — the
default server stays read-only. Both feed the two-phase show-before-share flow:

| Tool | What it does |
|------|--------------|
| `log_capture` | Validates a capture, scans for credentials, and returns a rendered preview plus a single-use staging token. Nothing is shared yet. |
| `confirm_capture` | Commits and shares a staged capture — call only after the user has seen the preview and approved. |

## search

Full-text search across every layer, scored and deduplicated by concept ID.

Arguments: `query` (string, required), `limit` (number, default 10).

Each result is `{ id, title, score, layers, snippet }`, where `layers` are the
contributing layer names ordered by level (highest first).

## read_file

Reads the resolved effective concept across the cascade, with provenance. Pass
`layer` to read one layer's raw, unmerged concept instead.

Arguments: `concept_id` (string, required), `layer` (string, optional).

The resolved response shape:

```json
{
  "id": "decisions/primary-db",
  "contributors": [
    { "layer": "personal", "level": 3, "updated": "2026-02-10" },
    { "layer": "team",     "level": 2, "updated": "2026-01-22" },
    { "layer": "company",  "level": 0, "updated": "2025-11-30" }
  ],
  "frontmatter": { "type": "decision", "title": "Primary database" },
  "frontmatterProvenance": { "type": "company", "title": "team" },
  "sections": [
    {
      "key": "decision",
      "heading": "## Decision {#decision}",
      "content": "Use Postgres 16 with read replicas.",
      "sourceLayer": "team",
      "sourceUpdated": "2026-01-22",
      "conflicts": [
        { "layer": "company", "updated": "2025-11-30", "content": "Use Postgres 14." }
      ]
    },
    {
      "key": "rollback",
      "heading": "## Rollback {#rollback}",
      "content": "",
      "sourceLayer": "personal",
      "sourceUpdated": "2026-02-10",
      "suppressed": true
    }
  ],
  "markdown": "---\ntype: decision\n..."
}
```

Field by field:

| Field | Meaning |
|-------|---------|
| `id` | The resolved concept ID. |
| `contributors[]` | Every layer that defined this concept: `{ layer, level, updated }`, ordered highest precedence first. |
| `frontmatter` | Merged frontmatter — each key won by the highest-level layer that set it. |
| `frontmatterProvenance` | Map of each frontmatter key to the layer that supplied the winning value. |
| `sections[]` | Merged sections in effective order (see below). |
| `markdown` | The effective concept reassembled as OKF markdown, with conflicts rendered inline as blockquote notes. Added by the server. |

Each entry in `sections[]`:

| Field | Meaning |
|-------|---------|
| `key` | Section key (derived from its heading anchor). |
| `heading` | The section heading line. |
| `content` | The winning layer's section body. Empty string when suppressed. |
| `sourceLayer` | The layer whose section won. |
| `sourceUpdated` | Last-updated date of the winning section. |
| `conflicts` | Optional. Dissenting layers: `[{ layer, updated, content }]`. Present only when another layer defined the section with different content. |
| `suppressed` | Optional. `true` when a `{#anchor override=none}` tombstone hid an inherited section. Retained for audit; no conflicts are emitted. |

Where layers disagree on a section, the higher layer's value is primary and the
dissenters ride along in `conflicts` — the contradiction is surfaced, not hidden.
See [Conflicts and provenance](/docs/concepts/conflicts-and-provenance).

### Raw single-layer read

Pass `layer` to bypass the merge and read that one layer's concept as stored:

```json
{ "id": "decisions/primary-db", "layer": "team", "raw": true, "frontmatter": { ... }, "sections": [ ... ] }
```

## list_concepts

Lists effective concept IDs across the cascade with their contributing layers.

Arguments: `type` (string, optional) — filter by effective OKF type.

Each entry is `{ id, type, title, layers }`, sorted by ID, with `layers` ordered by
level. When `type` is given, entries are filtered by the resolved effective type.

## get_links

Returns outgoing and incoming links for a concept, resolved against the effective
graph.

Arguments: `concept_id` (string, required).

```json
{
  "source": { "id": "systems/auth-service", "contributors": [ ... ] },
  "outgoing": [
    { "raw": "[Primary DB](../decisions/primary-db)", "target": "../decisions/primary-db", "id": "decisions/primary-db", "layers": ["team", "company"] }
  ],
  "incoming": [
    { "id": "runbooks/auth-outage", "layer": "team", "raw": "[[systems/auth-service]]" }
  ]
}
```

`outgoing` links are extracted from the resolved body and matched to concept IDs;
`incoming` links are the concepts elsewhere in the cascade that point back.

## Running the server

Start it against a manifest (cascade mode) or an explicit two-layer stack (legacy
mode):

```bash
node mcp-server.mjs --manifest apps/playground/manifest.json
```

```bash
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared
```

The server communicates over stdin/stdout, so register it as a stdio MCP server in
your agent client — for a full walkthrough (including a Claude config example) see
[Connect an agent](/docs/getting-started/connect-an-agent). The manifest is a trust
boundary: an `mcp` layer spawns a command from it, so only serve manifests you
trust ([the trust boundary](/docs/concepts/trust-boundary)).

## Related

- [layers.json manifest](/docs/reference/manifest) — what you serve
- [CLI](/docs/reference/cli) — `mcp-server.mjs` flags
- [Override syntax](/docs/reference/override-syntax) — what produces `suppressed` and `conflicts`
