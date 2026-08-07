# ContextCake

## Commands

```bash
# Run all tests (the chain lives in package.json "test" — read it there rather
# than mirroring it here, which is how the two drifted apart before)
npm test

# Run one suite while iterating
bash packages/core/tests/resolver-test.sh
node --test packages/core/tests/search.test.mjs

# Retrieval eval — scores search.mjs against the golden question set.
# Part of npm test: a ranking change that loses recall fails the build.
npm run eval
node packages/core/eval/run.mjs --verbose                    # show what each miss returned instead
node packages/core/eval/run.mjs --record --label "why"       # accept a new number, with its reason

# Run the MCP server (cascade mode)
node mcp-server.mjs --manifest layers.json

# Run the MCP server (legacy 2-layer)
node mcp-server.mjs --personal ~/kb-personal --shared ~/kb-shared

# Team sync: capture + telemetry (requires one "live": true layer with a "git" block)
node mcp-server.mjs --manifest layers.json --capture --telemetry --harness claude-code

# Promote a live capture through the review queue (request, then approve)
node promote.mjs --legacy-paths --from-live ~/kb-live --capture captures/investigation/<id> --target ~/kb-team
node promote.mjs --legacy-paths --from-live ~/kb-live --target ~/kb-team --approve ~/kb-team/_review/promotions/<slug>.md

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

- **Storage is federated** — each layer is a `source` behind a uniform adapter: an `okf-local` bundle, a plain `files` folder, a remote `github` repository, or an `mcp` foreign graph translated into OKF at read time.
- **Reading is unified** — `resolver.mjs` stitches the sources into one effective OKF concept at read time.
- **Finding is ranked** — `search.mjs` (BM25F over Porter-stemmed tokens) decides which concept an agent gets to resolve in the first place. Everything the cascade is good at is downstream of it.
- **Layer precedence** — Personal (3) > Team (2) > Company (0). Higher wins per section. Levels are configurable per layer in the manifest.
- **Section/field merge** — not whole-document replacement. A higher layer speaks to what it knows; the rest is inherited. Where layers disagree, the primary value carries per-section `conflicts[]` (dissenting layer + date) — surfaced, not hidden.
- **MCP server** — `mcp-server.mjs` exposes the resolved graph to AI agents (search, read_file, list_concepts, get_links).
- **Write path** — `ingest.mjs` classifies repo signals; `write.mjs` writes captures to the target layer.

Key files:

| File | Role |
|------|------|
| `packages/core/src/resolver.mjs` | Core cascade engine: section merge, precedence, provenance, conflict surfacing. Formatting-equivalent dissent is dropped via `conflict-policy.mjs`; sections carry `fresherDissent: true` when a dissent postdates the effective value |
| `packages/core/src/conflict-policy.mjs` | Conflict policy shared by the resolver and MCP server: `equivalent()` (formatting-equivalence dissent suppression — whitespace, unordered-bullet glyph, blank-line runs only; everything else stays a conflict) and `isNewerDay()` (day-granularity freshness behind `fresherDissent` and the markdown "newer than the effective value" marker) |
| `packages/core/src/search.mjs` | Ranking behind the `search` and `find_captures` tools: BM25F over stemmed tokens, per-field boosts and length normalization, 7-day recency half-life for captures. Importable and side-effect-free precisely so the eval can score it |
| `packages/core/src/stem.mjs` | Porter stemmer (1980). Deliberately the published algorithm, not a hand-tuned suffix list — see the note in the file |
| `packages/core/eval/` | Retrieval eval: committed 3-layer corpus, golden question set, runner, and `baseline.json` with the score history |
| `packages/core/src/service.mjs` | Embeddable HTTP service: read API, background index, sources CRUD, settings, file APIs, console mount |
| `packages/core/src/index-keys.mjs` | How a background index entry is named: a layer's content `identity`, the `validity` that adds the indexing policy, and the per-row `key`. Pure and separately tested because a key collision means one source serving another's documents |
| `packages/core/src/settings.mjs` | User-configurable engine limits (manifest > env > default) + validation and the UI catalog |
| `packages/core/src/layer-files.mjs` | Layer file explorer/editor APIs (`/api/files`, `/api/file`, `/api/section`), sandboxed to layer roots |
| `packages/core/src/http-util.mjs` | Shared HTTP internals: CSRF/loopback guard, containment guard, json/readBody helpers |
| `packages/core/src/mcp-server.mjs` | stdio MCP server; resolves via resolver.mjs; renders conflicts in markdown |
| `packages/core/src/sources/okf-local.mjs` | OKF-local source adapter: reads OKF markdown bundles from disk. Owns `withDocumentDate` (the section-date fallback chain, shared with every other adapter) and dates undated sections from git history (author dates, batched + TTL-memoized), never the mtime |
| `packages/core/src/sources/mcp.mjs` | MCP source adapter: spawns a foreign stdio MCP server, translates to OKF. Add-time probe requires both `list_nodes` and `get_node` in `tools/list` (a compliant-but-wrong server fails add with a distinct "doesn't speak the ContextCake graph contract" error rather than a false "did not respond"). `health()` duck-types the github adapter's shape exactly, including `lastErrorScope: "index"` — that literal value is what lights up the existing `service.mjs` degraded-status logic; a shape drift here silently disables degraded-marking for MCP sources |
| `packages/core/src/sources/files.mjs` | Files source adapter: any plain folder of `.md`/`.mdx`/`.txt` docs becomes a layer (OKF parsing when frontmatter present, synthesized sections otherwise). Owns `parseDocument`, shared with remote adapters so section keys match |
| `packages/core/src/sources/github.mjs` | GitHub source adapter: a repo's `CLAUDE.md`/`AGENTS.md`/`README.md`/`docs/**` become a layer without a clone — tree calls scoped per path selector (so a repo past GitHub's tree-listing limit still indexes), raw content, last-commit dates, `health()` for diagnosing a swallowed API failure, warn-and-continue on API failure |
| `packages/core/src/sources/cache.mjs` | TTL cache wrapper for any source adapter (memory + optional disk, `sync()` to invalidate) — opt-in per layer via a manifest `cache` block |
| `packages/core/src/sources/git-core.mjs` | Locked git mutation coordinator for live layers: intended-paths commits, push with offline queue + rebase retry, URL-scrubbed errors |
| `packages/core/src/sources/git-sync.mjs` | withGitSync wrapper (TTL-gated pull, 14-day capture decay, sync() lands queued pushes) + `resolveLiveLayer` manifest contract |
| `packages/core/src/capture.mjs` | Session captures: 4-kind schema validation, credential hard-reject, capture-policy routing, two-phase stage/confirm (show-before-share) |
| `packages/core/src/team-activity.mjs` | Aggregates live-layer captures + telemetry NDJSON into control-surface feed and reuse metrics (cross-brain hits) |
| `packages/core/fixtures/capture-policy.json` | Routing policy for agent-session captures (kinds → team_candidate; review keywords warn; dominant scratch signals → ignore) |
| `examples/team-sync-pack/` | Capture pack: Claude Code plugin (skill + Stop-hook nudge), Cursor rules, Copilot snippet, operator runbook |
| `packages/core/src/sources/index.mjs` | Source factory: builds adapters from a manifest (`okf-local` default, `files`, `github`, or `mcp`) |
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
| `apps/desktop/` | ContextCake for Mac: Electron shell — engine in an isolated utility process behind a token-guarded loopback service, console build as renderer, `contextcake` CLI shim, electron-updater. See `apps/desktop/CLAUDE.md` + `specs/contextcake-distribution/design.md`. |
| `apps/site/` | Public product site (Astro + Starlight). Spec + boundaries: `specs/contextcake-site/`. Site deps live in `apps/site/package.json` only — the engine stays dependency-free. |
| `specs/contextcake-packs/` | Public spec and private-repo template for ContextCake Packs, a separately sold product line whose paid content lives outside this public-bound engine repo. |
| `docs/architecture/README.md` | Historical design spec (partially superseded — see note at top) |

## Gotchas

- `layers.json` contains absolute paths — gitignored, each developer has their own.
- `apps/control-surface/signals.json` is generated — gitignored, produced by `ingest.mjs`.
- Staleness is surfaced via per-section `conflicts[]` + last-updated dates (the shadow/hash subsystem was removed in the core re-arch; see `specs/contextcake-core/design.md`). A section with no authored date falls back to a *content* date — git history for git-backed layers (`okf-local`, `github`), the file mtime only where no history can exist. Never date a section by mtime in a git-backed layer, and never by committer date: git does not preserve mtimes (a fresh clone would claim every doc was written today) and `pull --rebase` rewrites committer dates (which would re-date the whole bundle on the flow team-sync depends on). Where git genuinely cannot date a tracked file — a shallow clone's boundary commit lists the entire tree — leave the section undated rather than borrowing a date that reads as fresh.
- **The manifest is a trust boundary.** An `mcp` layer spawns `command` with `args` from the manifest — a manifest you did not author can run arbitrary commands as your user. Only point `--manifest` at configs you trust (same model as any MCP client config).
- **A manifest names credentials, never carries them.** A remote layer's `auth` may only be `"keychain:<alias>"` (resolved from the `tokens` map the caller injects into `buildSources` — the app owns the keychain, the engine never opens it) or `{"tokenEnv": "NAME"}` for headless runs. Any other shape throws, which is what structurally keeps a raw token out of a manifest. An alias with no injected secret reads anonymously rather than failing.
- **A manifest still decides where a named credential is *sent*.** A `github` layer's `apiBase` (the GitHub Enterprise knob) plus a valid `auth` alias means an untrusted manifest can direct a real token at a host it chooses. This is inside the existing manifest trust boundary, not a separate one — but when the desktop app writes manifests it should only ever emit the default `apiBase`.
- **The live layer's git repo is inside the team trust boundary.** Push access = the ability to inject unreviewed context into every teammate's agent; scope repo membership accordingly.
- Capture tools (`log_capture`/`confirm_capture`) exist only behind `mcp-server.mjs --capture`. The default server exposes 6 read-only tools (the original `search`/`read_file`/`list_concepts`/`get_links` stay byte-identical to the committed `fixtures/mcp-tools-baseline.json`, plus always-on read-only `find_captures`/`whats_new`); `--capture` adds the two write tools for 8. Telemetry (`--telemetry`) records concept ids and enums only — never content. Top-level tool `description` strings are NOT frozen by the baseline (only `name`/`inputSchema`/`annotations` are) — `search`/`read_file`/`get_links` descriptions teach conflict candor (sections may carry `conflicts[]`; weigh `fresherDissent`; `search` hits may carry `contested`/`conflictSections`).
- **The Mac app adds a `github-rest` source kind** (`POST /api/sources`) alongside the existing `github` clone kind — public repos read over the REST adapter with no clone (`repo`/`ref`/`paths`, default `cache:{ttlSeconds:900}`); private repos still use the clone kind ("uses your existing git credentials or SSH"). The app deliberately does not accept `auth`/`apiBase` from its own UI for `github-rest` in this release — the keychain `auth` alias resolution is real in the engine (`buildSources(manifest, dir, {tokens})`) but no caller in the app injects a `tokens` map yet, so an alias would silently read anonymously; headless users can still hand-write `{"auth":{"tokenEnv":"NAME"}}`.
- **Manifest reads are profile-view-unified.** `service.mjs` builds one `{...manifest, layers: getManifestProfileLayers(manifest)}` view in `openSources()` and threads it through every read site (index keys, `buildSources`, the manifest watcher, `layerMeta`, sync lookups) plus `layer-files.mjs`'s `layerRootMap` — a manifest migrated to v2 (e.g. by `contextcake profile create`) no longer empties the app's source list.
- All git mutations against a live root go through `git-core.mjs` (advisory `.contextcake.lock`, per-repo serialization) — never call git directly against a live layer from engine code.
- The engine (`packages/core/src/`) is dependency-free — plain Node.js built-ins only. Do not add npm dependencies without discussion. The exceptions are `apps/console/`, `apps/site/`, and `apps/desktop/` — self-contained npm packages. Console and site never import from the engine; the desktop app imports engine modules by path (one-way: app → engine, never the reverse) and must never cause a dependency to leak into `packages/core`.
- `apps/console/` and `apps/site/` each have their own `package.json`, build, and tests; run their commands from that subdirectory, not the repo root. Web Demo previews are path-filtered to `apps/console/**`; production deploys with the matching Mac app from the single `app-v*` release workflow.
- Tests create temp directories and clean up with `trap`. Run from the repo root.
- **Disk-backed source walks are async and bounded** (`walkDocs` in `okf-local.mjs`). Never reintroduce sync fs walks or unbounded per-source reads. The desktop app isolates the engine in an Electron utility process so engine work cannot freeze the main/UI process; bounded work still matters because the engine API must remain responsive.
- **Aggregate reads come from a background index and are often partial.** `/api/graph` and `/api/resolve-all` answer from whatever is indexed right now and report `indexing` / `indexingSources`; clients render what they have and poll. Any assertion about completeness (tests, scripts) must pass `?wait=<ms>`. `/api/resolve` deliberately reads one concept live. An index entry is keyed by its layer config + settings, so adding a source never re-indexes the existing ones.
- **Three strings name an index entry, and they are not interchangeable** (`index-keys.mjs`): `identity` = what the layer reads (no name/level, so a rename or re-level costs nothing); `validity` = identity + indexing settings + credential epoch; `key` = validity + the layer row, uniquified. `adoptIndexes` MOVES an orphaned entry to a new key when the validity matches — that is what makes a rename free — and drops it otherwise, which is what stops a lowered document cap or a disconnected account from serving the pre-change answer. Never match a handoff on identity alone, and never leave a user-supplied layer field able to reach a reserved slot in the identity (a stray `kind` field once made two layers share one entry).
- **`indexing` means "no answer yet", not "working".** A source with a snapshot that is being re-read stays `status: "ready"` and raises the additive `indexing.refreshing` flag, so a background refresh never flips a usable source (or the console's spinner) back to unready. `awaitIndexes` (`?wait=`) waits on the running pass, not on `status`. A pass dirtied mid-flight owes exactly one follow-up, and that follow-up waits out a quiet period as long as the last pass took (1–15s) — without it, sustained editing chained a full re-walk per edit forever.
- **Poll `/api/status`, not `/api/graph`.** `/api/status` is O(sources) — index progress and per-source state, no resolve, no tokenize — and carries a `generation` counter that moves whenever the graph payload would differ. A client polls it and refetches the heavy routes only when the number changes. `/api/graph`'s expensive half (concept rows + `resolvedTokens`) is memoized on the identity of the snapshots it read, and per-concept token counts come from the index rather than a per-request BPE encode; that cache is keyed by live state on every request rather than cleared by an invalidation event, precisely so there is no trigger to forget. Never reintroduce a per-request `countTokens` over the corpus — it cost 14.5s per call on a 139MB vault the console was polling every 900ms.
- **The indexing limits are user settings, not env-only** (`settings.mjs`, `GET`/`PATCH /api/settings`, Settings → Indexing in the console). Precedence is manifest > env > default — the manifest has to win or the settings UI would silently do nothing. Env vars (`CONTEXTCAKE_MAX_DOC_FILES`, `CONTEXTCAKE_MAX_SCAN_ENTRIES`, `CONTEXTCAKE_SOURCE_BUDGET_MS`) remain the headless/CI fallback.
- **Add-source validation is deliberately cheap**: only "folder is missing" and "that's a file" fail the form. A too-big folder is a normal thing to add — it becomes a visible source error after indexing, with a pointer at Settings. Don't reintroduce a full walk on the add path. MCP sources still probe (`tools/list`) at add time, which is bounded and catches a wrong command.
- **Retrieval is measured, not asserted.** `npm test` ends with the eval; a ranking change that loses recall fails the build with `RETRIEVAL REGRESSED`. If a change is a deliberate trade, re-record with `--record --label "<why>"` — the superseded numbers stay in `baseline.json`'s history so the trade is visible later. Do not tune the stemmer or the field boosts against the golden questions: the set is small enough to overfit in an afternoon, and a scorer fitted to its own eval measures nothing. Add questions first, then tune.
- **Layer file APIs live in the engine, not the playground** (`layer-files.mjs`), so the desktop app can browse and edit context files. They cover `files`-kind layers too — the playground's old copy only mapped `okf-local` roots, which made markdown folders invisible in the editor.
