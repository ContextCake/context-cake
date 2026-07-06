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

## Console (web UI)

A React + Vite front-end for reading and resolving the cascade — Canvas,
Overview, Triage, Conflicts, Concepts, and an "Ask ContextCake" assistant —
lives in [`console/`](console/) and deploys to Cloudflare Pages
(`https://contextcake-console.pages.dev`). It's a self-contained npm package; the
engine at the repo root stays dependency-free.

```bash
cd console
npm install
npm run dev        # http://localhost:5173
```

See [`console/README.md`](console/README.md) for the full tour.

## Release surfaces

This repo has more than one public-facing surface, and "live" is not a single
state across all of them.

- `site/` = marketing site, docs, and future demo surface
- `console/` = application UI on its own Cloudflare Pages project
- repo root = engine / MCP / CLI, which is not a hosted app by default

See [`docs/go-live.md`](docs/go-live.md) for the release contract and the exact
meaning of `merged`, `preview`, and `live` for each surface.

## `layers.json` shape

```json
{ "layers": [
  { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" },
  { "name": "team",     "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "company",  "level": 0, "source": "mcp", "command": "node", "args": ["./company-graph-server.mjs"] }
] }
```

A layer declares a `source`. An **`okf-local`** layer is an [OKF](https://cloud.google.com/blog/products/ai-machine-learning/google-cloud-launches-open-knowledge-format) bundle — a directory of markdown files with YAML frontmatter (the only required field is `type`). An **`mcp`** layer is a foreign knowledge graph reached over a stdio MCP server (`command` + `args`); its responses are translated into OKF at read time, so it stitches in alongside the local bundles. `source` defaults to `okf-local` when omitted. See `examples/mock-context-source.mjs` for a runnable foreign source.

## MCP tools

The MCP server exposes the resolved cascade to AI agents:

| Tool | What it does |
|------|-------------|
| `search` | Full-text search across all layers; returns one entry per concept with contributing layers |
| `read_file` | Returns the resolved effective concept — section merge + provenance + per-section conflicts. Pass `layer` for raw single-layer read. |
| `list_concepts` | All effective concept IDs with their contributing layers |
| `get_links` | Outgoing and incoming links, resolved against the effective graph |

Every `read_file` response includes `contributors`, `frontmatterProvenance`, and per-section `sourceLayer` so agents can weight facts by trust level. Where layers disagree on a section, the higher layer's value is primary and the dissenting layers ride along as `conflicts: [{ layer, updated, content }]` — the contradiction is surfaced, not hidden.

## Override semantics

| Syntax | Behavior |
|--------|----------|
| *(default)* | Section/field merge — higher layer wins per key |
| `override: full` in frontmatter | Whole-concept replacement; everything below is dropped |
| `{#anchor override=none}` | Null/tombstone — suppresses the inherited section. Retained as `suppressed: true` for audit. |

## Write path

```
repo activity → classify-context.mjs → ingest.mjs → signals.json → write.mjs → layer bundle
```

- `team_candidate` signals are written directly as draft OKF concepts.
- `review_required` signals are staged under `_review/` for human approval.
- Written concepts carry `draft: true` + `source` provenance.

## Architecture

Full design, decisions log, and diagrams: [`docs/architecture.md`](docs/architecture.md).
