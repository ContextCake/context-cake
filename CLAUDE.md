# ContextCake

## Commands

```bash
# Run all tests. The suite list lives in scripts/test.mjs — read it there
# rather than mirroring it here, which is how the two drifted apart before.
npm test
npm run test:list          # every suite and the group it belongs to
npm run test:unit          # or test:integration / test:release / test:slow
node scripts/test.mjs --only search   # one suite by name
node scripts/test.mjs --bail          # stop at the first failure

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
| `packages/core/src/service.mjs` | Embeddable HTTP service: read API, background index, file APIs, console mount. The sources-CRUD, settings, and discrepancy routes are parsing shims over `control/` (below). Background indexing runs through a concurrency-limited queue (`maxConcurrentIndexing` setting) rather than starting every source's pass at once; `POST /api/active-source` lets a client mark which layer is on screen so it jumps the queue |
| `packages/core/src/control/` | Shared control operations (control-plane spec): `sources.mjs` (source add/patch/remove validation, probes, clone lifecycle — git credentials injected as a capability, never read from service state), `settings.mjs` (view/patch), `discrepancies.mjs` (below), `errors.mjs` (`ControlError` with stable machine `code` + the HTTP status the service adapter answers with), `util.mjs` (`withDeadline`). The HTTP service and the CLI are adapters over these — fix behavior here, not in a route handler |
| `packages/core/src/control/discrepancies.mjs` | `createDiscrepancyOperations(caps)`: the one memoized discrepancy projection (keyed `corpusKey \| sourceHealthSig \| sidecarRevision`, read by the list/compact/summary/detail routes, the decision guard, and the automatic-rules job), decisions, rules, priorities, and recovery. Capabilities are injected — `corpus` (the host's resolved corpus + status from one pin), `fileRoots`, `selectedLayers`, the stores, `readLiveSection`, `onWritten`, `git: { commitPathsWithMutation, push }`. A decision touching the live team layer stages AND commits inside git-core's repo lock (F30). Why: [notes/discrepancy-projection.md](docs/architecture/notes/discrepancy-projection.md) |
| `packages/core/src/discrepancies.mjs` | Pure projection + wire shapes: `buildDiscrepancies` (records with `candidates`/`bestCandidate` on broken links — structural, never in `revision`), `summarizeDiscrepancies`, `compactDiscrepancy`, `filterDiscrepancies`, `ACTIONABLE_STATUSES`, and the link-text helpers `rewriteLinkTarget`/`removeLink` that walk exactly the patterns `extractLinks` reports |
| `packages/core/src/sidecar-state.mjs` | Profile-scoped durable sidecar layout: rules/priorities/resolution history/journals live at `.contextcake/profiles/<profile-id>/` beside the manifest; pre-profile unscoped files migrate to `profiles/default/` on first store access (idempotent, crash-resumable, refuses when a file exists in both layouts). The team-shared rules file inside a live layer root is NOT this state and stays unscoped |
| `packages/core/src/memory-pressure.mjs` | Memory-pressure watermark gating new indexing passes: the engine's own live heap (`heapUsed + external`) as a fraction of total system RAM, not `os.freemem()` (mostly reclaimable page cache) or raw RSS (a high-water mark V8 rarely releases) |
| `packages/core/src/index-keys.mjs` | How a background index entry is named: a layer's content `identity`, the `validity` that adds the indexing policy, and the per-row `key`. Pure and separately tested because a key collision means one source serving another's documents |
| `packages/core/src/manifest.mjs` | Manifest read/validate/mutate + profile views. `readContextManifestQuarantined` is the read path's tolerance: a single malformed layer is lifted out as a `{name, level, error}` record instead of 500-ing every route, while writes still validate strictly. `stableJson` is key-order-independent, so a manifest rewrite that only reorders fields never re-indexes a source |
| `packages/core/src/settings.mjs` | User-configurable engine limits (manifest > env > default) + validation and the UI catalog |
| `packages/core/src/layer-files.mjs` | Layer file explorer/editor APIs (`/api/files`, `/api/file`, `/api/section`), sandboxed to layer roots |
| `packages/core/src/http-util.mjs` | Shared HTTP internals: CSRF/loopback guard, containment guard, json/readBody helpers |
| `packages/core/src/mcp-server.mjs` | stdio MCP server; resolves via resolver.mjs; renders conflicts in markdown |
| `packages/core/src/sources/okf-local.mjs` | OKF-local source adapter: reads OKF markdown bundles from disk. Owns `withDocumentDate` (the section-date fallback chain, shared with every other adapter) and dates undated sections from git history (author dates, batched + TTL-memoized), never the mtime |
| `packages/core/src/sources/mcp.mjs` | MCP source adapter: spawns a foreign stdio MCP server, translates to OKF. Add-time probe requires both `list_nodes` and `get_node` in `tools/list` (a compliant-but-wrong server fails add with a distinct "doesn't speak the ContextCake graph contract" error rather than a false "did not respond"). `health()` duck-types the github adapter's shape exactly, including `lastErrorScope: "index"` — that literal value is what lights up the existing `service.mjs` degraded-status logic; a shape drift here silently disables degraded-marking for MCP sources |
| `packages/core/src/sources/files.mjs` | Files source adapter: any plain folder of `.md`/`.mdx`/`.txt` docs becomes a layer (OKF parsing when frontmatter present, synthesized sections otherwise). Owns `parseDocument`, shared with remote adapters so section keys match |
| `packages/core/src/sources/github.mjs` | GitHub source adapter: a repo's `CLAUDE.md`/`AGENTS.md`/`README.md`/`docs/**` become a layer without a clone — tree calls scoped per path selector (so a repo past GitHub's tree-listing limit still indexes), raw content, last-commit dates, `health()` for diagnosing a swallowed API failure, warn-and-continue on API failure |
| `packages/core/src/sources/cache.mjs` | TTL cache wrapper for any source adapter (memory + optional disk, `sync()` to invalidate) — opt-in per layer via a manifest `cache` block. The in-memory half evicts least-recently-used entries past `maxEntries` (default 5000) per source; the listing (`list.v2`) is kept in its own unbounded slot so a full sweep's N per-concept reads can never evict the one entry the sweep itself needs first |
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
| `apps/playground/` | Interactive playground: dependency-free HTTP server (`server.mjs`) over the engine + canvas/files/sources UI, merge resolver, per-source token budget. See `apps/playground/README.md`. |
| `apps/console/` | React + Vite + TS web UI (ContextCake Console) — its own npm package with a build step, deployed to Cloudflare Pages. See `apps/console/README.md` + `apps/console/CLAUDE.md`. |
| `apps/desktop/` | ContextCake for Mac: Electron shell — engine in an isolated utility process behind a token-guarded loopback service, console build as renderer, `contextcake` CLI shim, electron-updater. See `apps/desktop/CLAUDE.md` + `specs/contextcake-distribution/design.md`. |
| `apps/site/` | Public product site (Astro + Starlight). Spec + boundaries: `specs/contextcake-site/`. Site deps live in `apps/site/package.json` only — the engine stays dependency-free. |
| `specs/contextcake-packs/` | Public spec and private-repo template for ContextCake Packs, a separately sold product line whose paid content lives outside this public-bound engine repo. |
| `examples/self-layer/` | ContextCake's own architecture decisions as a real OKF bundle — a worked example, and something to point an agent at while working on the engine |
| `supabase/` | Settings-sync backend for the signed-in Mac app. Owned by `apps/desktop/`; the engine never touches it |
| `docs/architecture/notes/` | Why the non-obvious parts of the engine work the way they do — the reasoning behind the Gotchas below |
| `docs/architecture/README.md` | Historical design spec (partially superseded — see note at top) |

## Gotchas

- `layers.json` contains absolute paths — gitignored, each developer has their own.
- `apps/control-surface/signals.json` is generated — gitignored, produced by `ingest.mjs`.
- **Never date a section by mtime in a git-backed layer, and never by committer date.** Authored `updated` wins; otherwise a content date from git author history; mtime only where no history can exist; undated where git genuinely cannot answer. Why each alternative is wrong: [notes/section-dating.md](docs/architecture/notes/section-dating.md).
- **The manifest is a trust boundary.** An `mcp` layer spawns `command` with `args` from the manifest — a manifest you did not author can run arbitrary commands as your user. Only point `--manifest` at configs you trust (same model as any MCP client config).
- **A manifest names credentials, never carries them.** A remote layer's `auth` may only be `"keychain:<alias>"` (resolved from the `tokens` map the caller injects into `buildSources` — the app owns the keychain, the engine never opens it) or `{"tokenEnv": "NAME"}` for headless runs. Any other shape throws, which is what structurally keeps a raw token out of a manifest. An alias with no injected secret reads anonymously rather than failing.
- **A manifest still decides where a named credential is *sent*.** A `github` layer's `apiBase` (the GitHub Enterprise knob) plus a valid `auth` alias means an untrusted manifest can direct a real token at a host it chooses. This is inside the existing manifest trust boundary, not a separate one — but when the desktop app writes manifests it should only ever emit the default `apiBase`.
- **The live layer's git repo is inside the team trust boundary.** Push access = the ability to inject unreviewed context into every teammate's agent; scope repo membership accordingly.
- Capture tools (`log_capture`/`confirm_capture`) exist only behind `mcp-server.mjs --capture`. The default server exposes 6 read-only tools (the original `search`/`read_file`/`list_concepts`/`get_links` stay byte-identical to the committed `fixtures/mcp-tools-baseline.json`, plus always-on read-only `find_captures`/`whats_new`); `--capture` adds the two write tools for 8. Telemetry (`--telemetry`) records concept ids and enums only — never content. Top-level tool `description` strings are NOT frozen by the baseline (only `name`/`inputSchema`/`annotations` are) — `search`/`read_file`/`get_links` descriptions teach conflict candor (sections may carry `conflicts[]`; weigh `fresherDissent`; `search` hits may carry `contested`/`conflictSections`).
- **The Mac app adds a `github-rest` source kind** (`POST /api/sources`) alongside the existing `github` clone kind — public repos read over the REST adapter with no clone (`repo`/`ref`/`paths`, default `cache:{ttlSeconds:900}`); private repos still use the clone kind ("uses your existing git credentials or SSH"). The app deliberately does not accept `auth`/`apiBase` from its own UI for `github-rest` in this release — the keychain `auth` alias resolution is real in the engine (`buildSources(manifest, dir, {tokens})`) but no caller in the app injects a `tokens` map yet, so an alias would silently read anonymously; headless users can still hand-write `{"auth":{"tokenEnv":"NAME"}}`.
- **A bad layer is read around, never written around.** Reads quarantine an invalid layer (`readContextManifestQuarantined`); writes validate the whole manifest. Do not make `mutateContextManifest` tolerant to make some other route work — `repairContextManifest`, used only by `removeSourceApi`, is the one door allowed to see the mess. Removal is all-or-nothing and answers 409, never 500. Full rules: [notes/manifest-validation.md](docs/architecture/notes/manifest-validation.md).
- All git mutations against a live root go through `git-core.mjs` (advisory `.contextcake.lock`, per-repo serialization) — never call git directly against a live layer from engine code. That includes *file writes* into the live root: every decision that changes content — `POST /api/discrepancy-decisions`, automatic rules, and the legacy `POST /api/conflict-resolutions` — goes through `commitDecisionWrite` (control/discrepancies.mjs), which stages and renames inside `commitPathsWithMutation` when a target is in the live layer, never through a bare `stageSectionTransaction().commit()`. The Files editor (`writeFileApi`/`writeSectionApi`, `PUT /api/file` and `/api/section`) still bypasses this — a known, separate follow-up.
- **Every discrepancy read answers from one memoized projection** (`discrepancyOps.project()`), keyed on corpus + source health + sidecar stat + an in-process write counter. Never call `buildDiscrepancies` over the corpus anywhere else, and if you add a write path for decisions/rules/priorities outside `control/discrepancies.mjs`, call `discrepancyOps.noteWrite()` after it or the memo will serve the pre-write answer for up to one stat granularity. `GET /api/discrepancies` bare envelope is byte-compatible; `?fields=compact`/filters/`?id=`/`/summary` are additive.
- The engine (`packages/core/src/`) is dependency-free — plain Node.js built-ins only. Do not add npm dependencies without discussion. The exceptions are `apps/console/`, `apps/site/`, and `apps/desktop/` — self-contained npm packages. Console and site never import from the engine; the desktop app imports engine modules by path (one-way: app → engine, never the reverse) and must never cause a dependency to leak into `packages/core`.
- **There is no install step at the repo root, and adding one is the change to argue about.** `packages/core/package.json` exists to give the directory an identity and pin its module type — it is deliberately *not* an npm workspace, because declaring workspaces would force a root `npm install` and end the plain-Node guarantee. Consumers import the engine by relative path.
- `apps/console/` and `apps/site/` each have their own `package.json`, build, and tests; run their commands from that subdirectory, not the repo root. Web Demo previews are path-filtered to `apps/console/**`; production deploys with the matching Mac app from the single `app-v*` release workflow.
- **`CI / required` is the only branch-protection check.** Internal job names may change freely; that outer gate should not.
- **`app-v*` is the only product-release tag namespace.** The release workflow requires a commit already on `main`, publishes the Mac artifacts, then deploys the matching Web Demo from that exact commit. Ordinary site-only content changes keep their own deployment path.
- Root `.mjs` files are three-line CLI wrappers over `packages/core/src/` via `bin-shim.mjs` — the public command names predate the move into `packages/core`. Keep them working when canonical files move, and add a new one only by adding a `runCoreCli` call, never by re-inlining the body.
- Tests create temp directories and clean up with `trap`. Run from the repo root. `playground-test.sh` binds `127.0.0.1` — keep it runnable in CI and configurable by `PORT`, and expect it to need a less restricted sandbox than the rest.
- **Disk-backed source walks are async and bounded** (`walkDocs` in `okf-local.mjs`). Never reintroduce sync fs walks or unbounded per-source reads. The desktop app isolates the engine in an Electron utility process so engine work cannot freeze the main/UI process; bounded work still matters because the engine API must remain responsive.
- **Aggregate reads come from a background index and are often partial.** `/api/graph` and `/api/resolve-all` answer from whatever is indexed right now and report `indexing` / `indexingSources`; clients render what they have and poll. Any assertion about completeness (tests, scripts) must pass `?wait=<ms>`. `/api/resolve` deliberately reads one concept live.
- **Never match an index handoff on identity alone**, and never let a user-supplied layer field reach a reserved slot in the identity. Three strings name an entry (`index-keys.mjs`) — `identity`, `validity`, `key` — and `adoptIndexes` moves an orphan only on a validity match. Adding a source never re-indexes the existing ones; repointing a folder always does. Details: [notes/index-keys-and-adoption.md](docs/architecture/notes/index-keys-and-adoption.md).
- **`indexing` means "no answer yet", not "working".** A source being re-read stays `status: "ready"` with the additive `indexing.refreshing` flag; `awaitIndexes` (`?wait=`) waits on the running pass, not on `status`.
- **Poll `/api/status`, not `/api/graph`**, and never reintroduce a per-request `countTokens` over the corpus. Why, and what the poll gate actually is: [notes/status-polling.md](docs/architecture/notes/status-polling.md).
- **The indexing limits are user settings, not env-only** (`settings.mjs`, `GET`/`PATCH /api/settings`, Settings → Indexing in the console). Precedence is manifest > env > default — the manifest has to win or the settings UI would silently do nothing. Env vars (`CONTEXTCAKE_MAX_DOC_FILES`, `CONTEXTCAKE_MAX_SCAN_ENTRIES`, `CONTEXTCAKE_SOURCE_BUDGET_MS`, `CONTEXTCAKE_MAX_CONCURRENT_INDEXING`) remain the headless/CI fallback.
- **Indexing passes queue, they don't all start at once** (`pumpIndexQueue`, `maxConcurrentIndexing`, default 4), and memory pressure can hold them back entirely. The queue bounds when a pass may *start*, not how long one stays alive — and `github.mjs`/`mcp.mjs` don't check the abort signal while listing, so a timed-out remote scan can outlive its slot. Known gap, spelled out in [notes/index-queue-and-memory.md](docs/architecture/notes/index-queue-and-memory.md).
- **Source add and repoint stay cheap.** Only "folder is missing" and "that's a file" fail the add form; a too-big folder is a normal thing to add and indexes its first `maxDocFiles` documents with a visible partial warning (the scan cap — a home directory — still errors). Don't put a full walk on either path. MCP sources still probe (`tools/list`) at add time.
- **Index passes are incremental for local layers.** The walk fingerprints every document (`listEntries`: rel/ext/size/mtimeMs, plus the git `authoredDate` for `okf-local` — a commit changes a document's date without changing the document) and `snapshotSource` carries unchanged concepts forward as the same object — one edit costs one read; a pass that changed nothing returns the previous snapshot object so memos stay warm. "Nothing changed" is `canReuseSnapshot`, and it deliberately refuses when anything carried from the retry seed: that content is newer than the served snapshot even though the pass read nothing. Token counts persist across restarts (`token-count-cache.mjs`, `.cache/index/` beside the manifest). A transiently failed pass (timeout, EMFILE) retries on a bounded backoff and RESUMES from its carry seed; `?wait=` never waits on a parked retry. Search reuses a per-generation incremental BM25F index (`search-index.mjs`) that is differential-tested bit-identical to `searchConcepts` — which remains the scorer of record for the eval and mcp-server.
- **Retrieval is measured, not asserted.** `npm test` runs the eval; a ranking change that loses recall fails the build with `RETRIEVAL REGRESSED`. If a change is a deliberate trade, re-record with `--record --label "<why>"` — the superseded numbers stay in `baseline.json`'s history so the trade is visible later. Do not tune the stemmer or the field boosts against the golden questions: the set is small enough to overfit in an afternoon, and a scorer fitted to its own eval measures nothing. Add questions first, then tune.
- **Layer file APIs live in the engine, not the playground** (`layer-files.mjs`), so the desktop app can browse and edit context files. They cover `files`-kind layers too — the playground's old copy only mapped `okf-local` roots, which made markdown folders invisible in the editor. The console's Web Demo browses the same tree read-only: `apps/console/scripts/build-demo-data.mjs` calls `listFilesApi`/`readFileApi` over `apps/playground/demo-layers/` at build time. Like the resolved concepts beside it, that fixture is generated from real engine output — never hand-authored — and it captures only the two GET answers, so the demo has no write path to fake.
