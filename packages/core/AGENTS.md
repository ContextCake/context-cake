# ContextCake Core

## Commands

```bash
# From repo root
npm test
bash packages/core/tests/smoke-test.sh
bash packages/core/tests/resolver-test.sh
bash packages/core/tests/source-test.sh

node resolver.mjs --manifest apps/playground/manifest.json --concept decisions/primary-db
node mcp-server.mjs --manifest apps/playground/manifest.json
node classify-context.mjs --demo
node ingest.mjs --demo
node write.mjs --signals apps/control-surface/signals.json --manifest layers.json --target-layer team --dry-run
```

## Architecture

- `src/resolver.mjs` is the canonical cascade engine: OKF parsing, section merge, precedence, provenance, conflicts, and suppression.
- `src/mcp-server.mjs` exposes the resolved graph over stdio MCP.
- `src/sources/` contains source adapters; `okf-local` reads markdown bundles and `mcp` translates foreign MCP sources into OKF.
- `src/classify-context.mjs`, `src/ingest.mjs`, `src/write.mjs`, and `src/promote.mjs` are the capture/write path — which now includes agent-session captures: `src/capture.mjs` (two-phase stage/confirm, credential hard-reject, `fixtures/capture-policy.json` routing), `src/sources/git-core.mjs` + `src/sources/git-sync.mjs` (locked git sync for the live layer), and `src/team-activity.mjs` (feed + reuse metrics).
- `fixtures/` holds bundled demo policy, repo config, and normalized events.
- `tests/` holds shell-based integration tests. Root `npm test` is the public gate.

## Gotchas

- Keep the core dependency-free. Use only Node.js built-ins unless the project explicitly approves a packaging change.
- Root `.mjs` files are compatibility wrappers. Keep them working when canonical files move or CLI behavior changes.
- Manifest files are a trust boundary; `mcp` sources can spawn commands from `command` and `args`.
- `npm test` includes a playground test that binds `127.0.0.1`; it may need a less restricted local environment than some sandboxes.
- Fixtures are committed. Generated dashboard data belongs under `apps/control-surface/signals.json` (and `team-activity.json`) and is ignored.
- Live-layer git mutations go through `git-core.mjs` (`.contextcake.lock` serializes concurrent harness processes) — never spawn git directly against a live root.
- `mcp-server.mjs` treats `--capture`/`--telemetry` as boolean flags; every other `--flag` consumes a value. The no-flag tool surface must stay byte-identical to `fixtures/mcp-tools-baseline.json`.
- Telemetry NDJSON is content-free by invariant: `{ts,user,harness,event,concept,layer,captureKind}` — ids and enums, never section text. The team-sync test greps fixture content against the telemetry dir to enforce this.
