# ContextCake

## Commands

```bash
# Run all tests
npm test
# or directly:
bash smoke-test.sh && bash resolver-test.sh && bash source-test.sh && bash playground-test.sh

# Run the MCP server (cascade mode)
node mcp-server.mjs --manifest layers.json

# Run the MCP server (legacy 2-layer)
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared

# Run the MCP server with a foreign MCP source (layer may declare "source": "mcp" with "command"/"args")
# See examples/mock-context-source.mjs for a runnable foreign source usable in tests.

# Ingest repo signals → signals.json
node ingest.mjs --events mock-events.json --out control-surface/signals.json

# Write captured signals → OKF layer bundle
node write.mjs --signals control-surface/signals.json --manifest layers.json --target-layer team

# Resolve a concept across layers (CLI)
node resolver.mjs --manifest layers.json --concept decisions/primary-db

# Serve the control surface dashboard
python3 -m http.server 8788 --directory control-surface

# Run the interactive playground (canvas + file editor + merge resolver + source config)
npm run playground              # serves http://127.0.0.1:8790
# see playground/README.md for the full tour

# Product site (marketing + docs) — Astro/Starlight; spec: specs/contextcake-site/
cd site && npm install && npm run dev    # http://localhost:4321
cd site && npm run build                 # site CI gate — must exit 0

# Seed + verify the team demo (then see demo/RUNBOOK.md for the live script)
# NOTE: currently BROKEN — demo/setup.sh + verify.sh use the removed --hash/--shadow
# flags. Pending reconciliation with the core re-arch (see specs/contextcake-core/design.md §10).
npm run demo:verify
```

## Architecture

See `docs/architecture.md` for the full design. Short version:

- **Storage is federated** — each layer is a `source` behind a uniform adapter: an `okf-local` bundle (git repo of OKF markdown) or an `mcp` foreign graph translated into OKF at read time.
- **Reading is unified** — `resolver.mjs` stitches the sources into one effective OKF concept at read time.
- **Layer precedence** — Personal (3) > Team (2) > Company (0). Higher wins per section. Levels are configurable per layer in the manifest.
- **Section/field merge** — not whole-document replacement. A higher layer speaks to what it knows; the rest is inherited. Where layers disagree, the primary value carries per-section `conflicts[]` (dissenting layer + date) — surfaced, not hidden.
- **MCP server** — `mcp-server.mjs` exposes the resolved graph to AI agents (search, read_file, list_concepts, get_links).
- **Write path** — `ingest.mjs` classifies repo signals; `write.mjs` writes captures to the target layer.

Key files:

| File | Role |
|------|------|
| `resolver.mjs` | Core cascade engine: section merge, precedence, provenance, conflict surfacing |
| `mcp-server.mjs` | stdio MCP server; resolves via resolver.mjs; renders conflicts in markdown |
| `sources/okf-local.mjs` | OKF-local source adapter: reads OKF markdown bundles from disk |
| `sources/mcp.mjs` | MCP source adapter: spawns a foreign stdio MCP server, translates to OKF |
| `sources/index.mjs` | Source factory: builds adapters from a manifest (`okf-local` default, or `mcp`) |
| `examples/mock-context-source.mjs` | Runnable non-OKF foreign MCP server for integration tests |
| `classify-context.mjs` | Classifies repo events into ignore / local / team_candidate / review_required |
| `ingest.mjs` | Batch classifier: events → signals.json |
| `write.mjs` | Writes signals to OKF layer bundles |
| `promote.mjs` | Promotes a concept up one level (personal → shared) |
| `context-policy.json` | Classification rules (keywords, labels, paths) |
| `control-surface/` | Dashboard: review queue, captured feed, repo coverage |
| `okf-browser/` | OKF graph browser |
| `playground/` | Interactive playground: dependency-free HTTP server (`server.mjs`) over the engine + canvas/files/sources UI, merge resolver, per-source token budget. See `playground/README.md`. |
| `console/` | React + Vite + TS web UI (ContextCake Console) — its own npm package with a build step, deployed to Cloudflare Pages. See `console/README.md` + `console/CLAUDE.md`. |
| `site/` | Public product site (Astro + Starlight). Spec + boundaries: `specs/contextcake-site/`. Site deps live in `site/package.json` only — the engine stays dependency-free. |
| `docs/architecture.md` | Historical design spec (partially superseded — see note at top) |

## Gotchas

- `layers.json` contains absolute paths — gitignored, each developer has their own.
- `control-surface/signals.json` is generated — gitignored, produced by `ingest.mjs`.
- Staleness is surfaced via per-section `conflicts[]` + last-updated dates (the shadow/hash subsystem was removed in the core re-arch; see `specs/contextcake-core/design.md`).
- **The manifest is a trust boundary.** An `mcp` layer spawns `command` with `args` from the manifest — a manifest you did not author can run arbitrary commands as your user. Only point `--manifest` at configs you trust (same model as any MCP client config).
- The engine (`resolver.mjs`, `sources/`) is dependency-free — plain Node.js built-ins only. Do not add npm dependencies without discussion. The exceptions are `console/` and `site/`, self-contained npm packages that never import from the engine — keep that boundary.
- `console/` and `site/` each have their own `package.json`, build, and tests; run their commands from that subdirectory, not the repo root. `console/` CI lives at `.github/workflows/console-*.yml`, path-filtered to `console/**` (production deploys on `console-v*` tags).
- Tests create temp directories and clean up with `trap`. Run from the repo root.
