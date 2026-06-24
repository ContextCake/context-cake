# ContextCake

Federated team knowledge with cascading layer precedence.

Engineers keep working in the repos they already use. ContextCake watches signals from that work, stores durable context when it's safe, and lets AI agents read the full picture — company policy, team decisions, personal notes — resolved into one effective view at read time.

## The layer cake

Knowledge is stored in separate git repos per organizational scope. Access control is free: repo membership = read access.

```
Personal  (level 3)  ← your drafts, notes, overrides
────────────────────
Team      (level 2)  ← runbooks, decisions, system docs
────────────────────
Group     (level 1)  ← cross-team standards, shared interfaces
────────────────────
Company   (level 0)  ← org-wide canonical knowledge
```

When a concept exists in multiple layers, higher layers win — **per section**. A team override replaces only what it speaks to; everything else is inherited from below. No knowledge lost.

```markdown
<!-- Company layer: decisions/primary-db.md -->
## Engine {#engine}
Postgres.

## Backups {#backups}
Nightly snapshots to cold storage.

<!-- Team layer: decisions/primary-db.md -->
## Engine {#engine}
SingleStore (chosen for HTAP workloads).

<!-- Effective (what agents see): -->
## Engine       ← Team wins
SingleStore (chosen for HTAP workloads).

## Backups      ← inherited from Company
Nightly snapshots to cold storage.
```

## Quick start

**No dependencies** — plain Node.js ≥ 18.

```bash
# Classify a repo event
node classify-context.mjs --demo

# Ingest a batch of events → signals.json
node ingest.mjs --demo

# Write captured signals into a layer bundle
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team

# Start the MCP server (cascade mode)
node mcp-server.mjs --manifest layers.json

# Start the MCP server (simple 2-layer)
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared

# Open the dashboard
python3 -m http.server 8788 --directory control-surface
# → http://127.0.0.1:8788

# Run tests
npm test
```

## `layers.json` shape

```json
{ "layers": [
  { "name": "personal", "level": 3, "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "path": "~/kb-team" },
  { "name": "group",    "level": 1, "path": "~/kb-data-group" },
  { "name": "company",  "level": 0, "path": "~/kb-company" }
] }
```

Each layer is an [OKF](https://cloud.google.com/blog/products/ai-machine-learning/google-cloud-launches-open-knowledge-format) bundle: a directory of markdown files with YAML frontmatter. The only required frontmatter field is `type`.

## MCP tools

The MCP server exposes the resolved cascade to AI agents:

| Tool | What it does |
|------|-------------|
| `search` | Full-text search across all layers; returns one entry per concept with contributing layers |
| `read_file` | Returns the resolved effective concept — section merge + provenance. Pass `layer` for raw single-layer read. |
| `list_concepts` | All effective concept IDs with their contributing layers |
| `get_links` | Outgoing and incoming links, resolved against the effective graph |

Every `read_file` response includes `contributors`, `frontmatterProvenance`, and per-section `sourceLayer` so agents can weight facts by trust level.

## Override semantics

| Syntax | Behavior |
|--------|----------|
| *(default)* | Section/field merge — higher layer wins per key |
| `override: full` in frontmatter | Whole-concept replacement; everything below is dropped |
| `{#anchor override=none}` | Null/tombstone — suppresses the inherited section. Retained as `suppressed: true` for audit. |
| `override: exception` in frontmatter | Same as merge, but flags the concept as `exception: true` — a scoped deviation from lower-layer policy |
| `{#anchor override=exception}` | Same at the section level |

## Write path

```
repo activity → classify-context.mjs → ingest.mjs → signals.json → write.mjs → layer bundle
```

- `team_candidate` signals are written directly as draft OKF concepts.
- `review_required` signals are staged under `_review/` for human approval.
- Written concepts carry `draft: true` + `source` provenance.

## Architecture

Full design, decisions log, and diagrams: [`docs/architecture.md`](docs/architecture.md).
