# ContextCake

## Commands

```bash
# Run all tests
npm test
# or directly (mirrors the npm test chain):
bash packages/core/tests/smoke-test.sh && bash packages/core/tests/resolver-test.sh && bash packages/core/tests/source-test.sh && bash packages/core/tests/files-source-test.sh && bash packages/core/tests/git-sync-test.sh && bash packages/core/tests/capture-test.sh && bash packages/core/tests/team-sync-mcp-test.sh && bash packages/core/tests/playground-test.sh && bash packages/core/tests/service-test.sh && bash packages/core/tests/mcp-respawn-test.sh

# Run the MCP server (cascade mode)
node mcp-server.mjs --manifest layers.json

# Run the MCP server (legacy 2-layer)
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared

# Team sync: capture + telemetry (requires one "live": true layer with a "git" block)
node mcp-server.mjs --manifest layers.json --capture --telemetry --harness claude-code

# Promote a live capture through the review queue (request, then approve)
node promote.mjs --from-live ~/kb-live --capture captures/investigation/<id> --target ~/kb-team
node promote.mjs --from-live ~/kb-live --target ~/kb-team --approve ~/kb-team/_review/promotions/<slug>.md

# Team activity dashboard data (feed + cross-brain-hit metrics)
node team-activity.mjs --live-root ~/kb-live --out apps/control-surface/team-activity.json

# Run the MCP server with a foreign MCP source (layer may declare "source": "mcp" with "command"/"args")
# See examples/mock-mcp-source/server.mjs for a runnable foreign source usable in tests.

# Ingest repo signals → signals.json
node ingest.mjs --events packages/core/fixtures/mock-events.json --out apps/control-surface/signals.json

# Write captured signals → OKF layer bundle
node write.mjs --signals apps/control-surface/signals.json --manifest layers.json --target-layer team

# Resolve a concept across layers (CLI)
node resolver.mjs --manifest layers.json --concept decisions/primary-db

# Serve the control surface dashboard
python3 -m http.server 8788 --directory apps/control-surface

# Run the interactive playground (canvas + file editor + merge resolver + source config)
npm run playground              # serves http://127.0.0.1:8790
# see apps/playground/README.md for the full tour

# Product site (marketing + docs) — Astro/Starlight; spec: specs/contextcake-site/
cd apps/site && npm install && npm run dev    # http://localhost:4321
cd apps/site && npm run build                 # site CI gate — must exit 0

# Seed + verify the team demo (then see examples/team-demo/RUNBOOK.md)
npm run demo:verify

# Mac app (Electron shell over the engine + console) — see apps/desktop/CLAUDE.md
cd apps/desktop && npm install && npm run dev
cd apps/desktop && npm run smoke      # headless boot + token-guard check
```

## Architecture

See `docs/architecture/README.md` for the full design. Short version:

- **Storage is federated** — each layer is a `source` behind a uniform adapter: an `okf-local` bundle (git repo of OKF markdown) or an `mcp` foreign graph translated into OKF at read time.
- **Reading is unified** — `resolver.mjs` stitches the sources into one effective OKF concept at read time.
- **Layer precedence** — Personal (3) > Team (2) > Company (0). Higher wins per section. Levels are configurable per layer in the manifest.
- **Section/field merge** — not whole-document replacement. A higher layer speaks to what it knows; the rest is inherited. Where layers disagree, the primary value carries per-section `conflicts[]` (dissenting layer + date) — surfaced, not hidden.
- **MCP server** — `mcp-server.mjs` exposes the resolved graph to AI agents (search, read_file, list_concepts, get_links).
- **Write path** — `ingest.mjs` classifies repo signals; `write.mjs` writes captures to the target layer.

Key files:

| File | Role |
|------|------|
| `packages/core/src/resolver.mjs` | Core cascade engine: section merge, precedence, provenance, conflict surfacing |
| `packages/core/src/mcp-server.mjs` | stdio MCP server; resolves via resolver.mjs; renders conflicts in markdown |
| `packages/core/src/sources/okf-local.mjs` | OKF-local source adapter: reads OKF markdown bundles from disk |
| `packages/core/src/sources/mcp.mjs` | MCP source adapter: spawns a foreign stdio MCP server, translates to OKF |
| `packages/core/src/sources/files.mjs` | Files source adapter: any plain folder of `.md`/`.mdx`/`.txt` docs becomes a layer (OKF parsing when frontmatter present, synthesized sections otherwise) |
| `packages/core/src/sources/cache.mjs` | TTL cache wrapper for any source adapter (memory + optional disk, `sync()` to invalidate) — opt-in per layer via a manifest `cache` block |
| `packages/core/src/sources/git-core.mjs` | Locked git mutation coordinator for live layers: intended-paths commits, push with offline queue + rebase retry, URL-scrubbed errors |
| `packages/core/src/sources/git-sync.mjs` | withGitSync wrapper (TTL-gated pull, 14-day capture decay, sync() lands queued pushes) + `resolveLiveLayer` manifest contract |
| `packages/core/src/capture.mjs` | Session captures: 4-kind schema validation, credential hard-reject, capture-policy routing, two-phase stage/confirm (show-before-share) |
| `packages/core/src/team-activity.mjs` | Aggregates live-layer captures + telemetry NDJSON into control-surface feed and reuse metrics (cross-brain hits) |
| `packages/core/fixtures/capture-policy.json` | Routing policy for agent-session captures (kinds → team_candidate; review keywords warn; dominant scratch signals → ignore) |
| `examples/team-sync-pack/` | Capture pack: Claude Code plugin (skill + Stop-hook nudge), Cursor rules, Copilot snippet, operator runbook |
| `packages/core/src/sources/index.mjs` | Source factory: builds adapters from a manifest (`okf-local` default, `files`, or `mcp`) |
| `examples/mock-mcp-source/server.mjs` | Runnable non-OKF foreign MCP server for integration tests |
| `packages/core/src/classify-context.mjs` | Classifies repo events into ignore / local / team_candidate / review_required |
| `packages/core/src/ingest.mjs` | Batch classifier: events → signals.json |
| `packages/core/src/write.mjs` | Writes signals to OKF layer bundles |
| `packages/core/src/promote.mjs` | Promotes a concept up one level (personal → shared) |
| `packages/core/fixtures/context-policy.json` | Classification rules (keywords, labels, paths) |
| `apps/control-surface/` | Dashboard: review queue, captured feed, repo coverage |
| `apps/okf-browser/` | OKF graph browser |
| `apps/playground/` | Interactive playground: dependency-free HTTP server (`server.mjs`) over the engine + canvas/files/sources UI, merge resolver, per-source token budget. See `apps/playground/README.md`. |
| `apps/console/` | React + Vite + TS web UI (ContextCake Console) — its own npm package with a build step, deployed to Cloudflare Pages. See `apps/console/README.md` + `apps/console/CLAUDE.md`. |
| `apps/desktop/` | ContextCake for Mac: Electron shell — engine in the main process behind a token-guarded loopback service, console build as renderer, `contextcake` CLI shim, electron-updater. See `apps/desktop/CLAUDE.md` + `specs/contextcake-distribution/design.md`. |
| `apps/site/` | Public product site (Astro + Starlight). Spec + boundaries: `specs/contextcake-site/`. Site deps live in `apps/site/package.json` only — the engine stays dependency-free. |
| `specs/contextcake-packs/` | Public spec and private-repo template for ContextCake Packs, a separately sold product line whose paid content lives outside this public-bound engine repo. |
| `docs/architecture/README.md` | Historical design spec (partially superseded — see note at top) |

## Gotchas

- `layers.json` contains absolute paths — gitignored, each developer has their own.
- `apps/control-surface/signals.json` is generated — gitignored, produced by `ingest.mjs`.
- Staleness is surfaced via per-section `conflicts[]` + last-updated dates (the shadow/hash subsystem was removed in the core re-arch; see `specs/contextcake-core/design.md`).
- **The manifest is a trust boundary.** An `mcp` layer spawns `command` with `args` from the manifest — a manifest you did not author can run arbitrary commands as your user. Only point `--manifest` at configs you trust (same model as any MCP client config).
- **The live layer's git repo is inside the team trust boundary.** Push access = the ability to inject unreviewed context into every teammate's agent; scope repo membership accordingly.
- Capture tools (`log_capture`/`confirm_capture`) exist only behind `mcp-server.mjs --capture`. The default server exposes 6 read-only tools (the original `search`/`read_file`/`list_concepts`/`get_links` stay byte-identical to the committed `fixtures/mcp-tools-baseline.json`, plus always-on read-only `find_captures`/`whats_new`); `--capture` adds the two write tools for 8. Telemetry (`--telemetry`) records concept ids and enums only — never content.
- All git mutations against a live root go through `git-core.mjs` (advisory `.contextcake.lock`, per-repo serialization) — never call git directly against a live layer from engine code.
- The engine (`packages/core/src/`) is dependency-free — plain Node.js built-ins only. Do not add npm dependencies without discussion. The exceptions are `apps/console/`, `apps/site/`, and `apps/desktop/` — self-contained npm packages. Console and site never import from the engine; the desktop app imports engine modules by path (one-way: app → engine, never the reverse) and must never cause a dependency to leak into `packages/core`.
- `apps/console/` and `apps/site/` each have their own `package.json`, build, and tests; run their commands from that subdirectory, not the repo root. Console CI lives at `.github/workflows/console-*.yml`, path-filtered to `apps/console/**` (production deploys on `console-v*` tags).
- Tests create temp directories and clean up with `trap`. Run from the repo root.
