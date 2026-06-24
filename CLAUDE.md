# ContextCake

## Commands

```bash
# Run all tests
npm test
# or directly:
bash smoke-test.sh && bash resolver-test.sh

# Run the MCP server (cascade mode)
node mcp-server.mjs --manifest layers.json

# Run the MCP server (legacy 2-layer)
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared

# Ingest repo signals → signals.json
node ingest.mjs --events mock-events.json --out control-surface/signals.json

# Write captured signals → OKF layer bundle
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team

# Resolve a concept across layers (CLI)
node resolver.mjs --manifest layers.json --concept decisions/primary-db

# Detect stale overrides
node resolver.mjs --manifest layers.json --shadow

# Serve the control surface dashboard
python3 -m http.server 8788 --directory control-surface

# Seed + verify the team demo (then see demo/RUNBOOK.md for the live script)
npm run demo:verify
```

## Architecture

See `docs/architecture.md` for the full design. Short version:

- **Storage is federated** — one OKF markdown bundle (git repo) per organizational layer.
- **Reading is unified** — `resolver.mjs` merges layers into one effective concept at read time.
- **Layer precedence** — Personal (3) > Team (2) > Group (1) > Company (0). Higher wins per section.
- **Section/field merge** — not whole-document replacement. A higher layer speaks to what it knows; the rest is inherited.
- **MCP server** — `mcp-server.mjs` exposes the resolved graph to AI agents (search, read_file, list_concepts, get_links).
- **Write path** — `ingest.mjs` classifies repo signals; `write.mjs` writes captures to the target layer.

Key files:

| File | Role |
|------|------|
| `resolver.mjs` | Core cascade engine: section merge, precedence, provenance, shadow detection |
| `mcp-server.mjs` | stdio MCP server; resolves via resolver.mjs |
| `classify-context.mjs` | Classifies repo events into ignore / local / team_candidate / review_required |
| `ingest.mjs` | Batch classifier: events → signals.json |
| `write.mjs` | Writes signals to OKF layer bundles |
| `promote.mjs` | Promotes a concept up one level (personal → shared) |
| `context-policy.json` | Classification rules (keywords, labels, paths) |
| `control-surface/` | Dashboard: review queue, captured feed, repo coverage |
| `okf-browser/` | OKF graph browser |
| `docs/architecture.md` | Full design spec with decisions log |

## Gotchas

- `layers.json` contains absolute paths — gitignored, each developer has their own.
- `control-surface/signals.json` is generated — gitignored, produced by `ingest.mjs`.
- Shadow detection uses flat `overrides_layer` / `overrides_ref` frontmatter keys (not nested YAML) — a real YAML parser is future work.
- The resolver is dependency-free (plain Node.js). Do not add npm dependencies without discussion.
- Tests create temp directories and clean up with `trap`. Run from the repo root.
