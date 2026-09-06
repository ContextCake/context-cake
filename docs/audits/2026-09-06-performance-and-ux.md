# ContextCake performance, UX, and adoption audit

Date: 2026-09-06. Checkout: `191a404`. Installed Mac app: **0.7.5**.

ContextCake's strongest opportunity is to make reliable project context an automatic part of development: find the right decision, explain its source, use it in an agent, and preserve the useful learning afterward. The engine has a credible foundation. The main gaps are in agent-path performance, proving that setup worked, and reducing the work required to find and maintain useful knowledge.

This is an audit and proposed backlog, not an implementation or release certification. Product changes below are hypotheses to validate with developers; no retention analytics or user interviews were available.

Follow-up product priority: the user wants reliable unattended discrepancy resolution, optionally using a local model or an existing provider. The [approved automatic-resolution spec](../../specs/contextcake-automatic-resolution/spec.md) develops that capability, including evaluation gates and source-preserving decisions. Treat reliable detection, agent retrieval performance, and automatic resolution as a connected product effort. The [implementation record](./2026-09-06-implementation.md) tracks measured changes and outstanding stages separately from this baseline audit.

## Evidence and scope

- Inspected current console, desktop CLI, MCP, indexing, search, profiles, discrepancy parsing, setup, themes, and retrieval evaluation code.
- Used the installed Mac app through native UI automation. Preserved its existing `personal` source with 166 concepts.
- Added the real ContextCake checkout's `specs/` folder as **ContextCake specs**, below personal. Verified 89 concepts and healthy status. This source remains available for dogfooding.
- Added a temporary synthetic Markdown corpus with 3,000 documents, approximately 87 MB of text. Verified indexing progress, navigation, search, and a one-document refresh. Removed its source registration afterward; no existing source files were edited.
- Final installed state: **2 sources, 255 concepts, 4 actionable broken links**. The existing personal source remains first. The four alerts were inspected but no decisions or content repairs were applied.
- Exercised the packaged `contextcake mcp` CLI through JSON-RPC against the isolated synthetic corpus, using the app's own Electron runtime. No client configuration or account connection was changed.
- Inspected the public demo at 1200×757, 900×640, and 390×844. Public demo deployment is a separate surface; its timings are not Mac-app timings or proof that this checkout is deployed.

## Measurements

| Surface and workload | Result | Interpretation |
| --- | --- | --- |
| Installed app, existing 166-concept source | 529 ms index pass | Engine log measurement, not complete app launch time |
| Installed app, 89 real specification documents | 208 ms index pass | Small real source adds quickly |
| Installed app, synthetic 3,000-document source | 7,143 ms index pass | Progress visible; navigation remained available |
| Installed app, one synthetic document edited | 42 ms refresh pass | Incremental indexing is working; excludes watcher detection delay |
| Packaged MCP search, `database migration` | 3,822 ms | Five results, no protocol error |
| Packaged MCP search, `incident rollback` | 3,825 ms | Same process and corpus |
| Packaged MCP search, repeated `database migration` | 3,843 ms | Repeating the query does not remove corpus-wide work |
| Checkout graph-latency benchmark, 3,000 documents / 89.2 MB | Graph median 2.59 ms | Existing benchmark passed |
| Same benchmark, cheap requests during indexing | p95 3.68 ms, max 3.97 ms, 50 samples | Healthy event-loop responsiveness for this workload |
| Same benchmark, second index plus diagnostic refresh traffic | p95 14.25 ms, max 25.41 ms | Diagnostic traffic includes legacy resolve-all; not an exact replay of today's console |
| Checkout retrieval evaluation, 38 questions | Recall@1 89.5%; recall@5 100%; MRR .947; conflict checks 100% | No baseline regression; small curated set, not general retrieval accuracy |
| Public demo resource sample | JS 160,507 encoded / 572,056 decoded bytes; CSS 43,875 / 166,154 bytes | One unthrottled browser sample; not a field-performance percentile |

The first graph benchmark attempt could not reach its sandboxed loopback server and is excluded. It passed after rerunning with loopback permission. Packaged MCP measurements above supersede a preliminary run of bundled code under system Node.

Not measured: whole-app idle RSS/CPU, battery impact, packaged cold/warm launch percentiles, remote-source timeout behavior under injected failures, or representative 10k–50k-document vaults. No claim of complete WCAG conformance or sustained-load certification is made.

## Design assessment

The interface largely passes the product anti-pattern test: familiar navigation, restrained surfaces, standard controls, visible provenance, and useful density. Its issue is emphasis and task flow more than visual identity. The Review screen still layers explanatory copy, summary tiles, quick wins, status tabs, grouping, filters, and rules ahead of a small queue. Some labels describe internal architecture instead of the developer's task.

Directional audit scores, on the skill's 0–4 scale, for inspected surfaces only:

| Dimension | Score | Evidence |
| --- | --- | --- |
| Accessibility | 3 | Named controls, focus handling, semantic navigation, contrast test coverage; small reading/action targets and incomplete end-to-end verification |
| Performance | 2 | Strong desktop indexing; slow repeated MCP search; unbounded concept-list rendering |
| Responsive design | 2 | Main shell adapts, but narrow concept/provenance rows become difficult to read |
| Theming | 3 | Semantic tokens and multi-palette contrast tests exist; not all combinations were exercised visually |
| Anti-patterns | 3 | Mostly familiar product UI; unnecessary information density in Review and repetitive concept cards |
| **Total** | **13/20** | **Significant focused work; no evidence supporting a wholesale redesign** |

These scores are heuristic prioritization aids, not comparative product benchmarks. Inline hex colors are not automatically theme defects: `theme.ts` maps legacy literals to CSS variables.

## Prioritized findings

### 1. P1 — The agent's search path misses the console's main optimization

**Evidence:** [mcp-server.mjs](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/packages/core/src/mcp-server.mjs#L455) calls `searchConcepts`; [search.mjs](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/packages/core/src/search.mjs#L200) collects documents and rebuilds BM25F per request. [search-index.mjs](../../packages/core/src/search-index.mjs) already implements a reusable incremental index for the HTTP service. Packaged MCP searches took approximately 3.8 seconds each, including a repeated query.

**Impact:** A developer can experience a responsive app while their coding agent repeatedly waits for context. Multiple clients can multiply this work.

**Change:** Share a profile-aware indexed retrieval abstraction between HTTP and stdio. Preserve independent CLI operation when the app is closed. Use explicit content generations and adapter invalidation; do not cache indefinitely or route every client through one global mutable profile. Retain the existing scorer as the differential oracle.

**Acceptance:** Benchmark real stdio initialization, first search, repeated/distinct warm queries, one-file changes, and two clients. Proposed target: warm local search p95 below 200 ms on the documented 3,000-document fixture, with identical rankings and no recall regression. The target is not yet achieved or promised for remote cold starts.

### 2. P1 — “Ask” promises an in-app result that MCP connection does not enable

**Evidence:** The installed app says “Live asking needs a connected agent” and sends the user to Connect. [ChatPanel.tsx](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/components/ChatPanel.tsx#L20) enables live composition only when `window.claude.complete` exists. The connection flow configures an external MCP client, not that completion hook. Demo answers are explicitly canned.

**Impact:** A user may successfully connect their agent, return to Ask, and still find no working composer. This undermines the first success moment.

**Change:** Make the default action “Ask in your agent,” with a prepared question and clear destination. Keep local search immediately usable. Only offer in-app chat when an explicitly configured provider actually exists. Show distinct states: configuration prepared, client registered, first tool request received, source successfully read. Do not infer connection from copying a command.

**Acceptance:** A new user obtains one answer from their own source in their chosen client and can inspect its provenance. Every setup status reflects observed behavior.

### 3. P1 — Documentation examples generate false broken-link work

**Evidence:** Adding real specs produced alerts for `wiki-style` and `incident-response` in an OKF-format explanation. Those references are inside inline code, explicitly illustrating syntax. [extractLinks](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/packages/core/src/discrepancies.mjs#L254) regex-matches raw text. Direct reproduction also extracts a wikilink inside a fenced code example.

**Impact:** Importing good documentation creates unnecessary maintenance and offers edits that could damage examples. Repeated false alerts teach users to ignore the queue.

**Change:** Recognize Markdown code spans/fences and escaped syntax before extracting links. Share the same recognized spans with link rewrite/unlink operations and MCP link reporting so a proposed fix cannot target text the detector should ignore. Separately distinguish a genuinely missing concept from a target outside the configured source boundary.

**Acceptance:** Real links still surface; inline/fenced examples do not; rewrite/unlink preserve examples byte-for-byte. Use the actual documentation examples as regression cases.

### 4. P2 — Search communicates the wrong state and hides why results matched

**Evidence:** Installed search for `database migration` first displayed “No matching concepts,” then returned results. [Concepts.tsx](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/views/Concepts.tsx#L28) sets engine hits to null while awaiting its debounced search and falls back to the substring list. Result cards retain titles/IDs/layer labels but omit the backend's snippet. The list renders with `list.map`, unlike the virtualized Files and Discrepancies lists.

**Impact:** Users may abandon an unfinished search, open irrelevant documents, or pay unnecessary rendering cost when a broad substring matches thousands of concepts.

**Change:** Separate pending, complete-empty, failed, and partial results; retain useful previous results during refresh. Show matching passages, real source names, available dates, and conflict indicators. Window the concept list. Add source/type filters and keyboard next-result navigation. Explain the result limit or provide continuation.

**Acceptance:** No empty-result declaration before search completes; selection stays stable; 3k/10k matching rows mount a bounded number of elements; result-to-evidence is one action.

### 5. P2 — Concept reading loses document structure and scales poorly

**Evidence:** An existing personal CHANGELOG opens as **438 sections**. [ConceptDetail.tsx](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/components/ConceptDetail.tsx#L119) renders all sections and outputs `s.value` as plain text. The installed screen showed literal Markdown and flattened prose. Files already has a Markdown renderer.

**Impact:** Developers struggle to scan procedures, code, and decisions. Long documents dominate rendering and browsing.

**Change:** Reuse safe Markdown rendering for resolved sections and dissent; add section navigation, matched-section jumps, collapse controls, and bounded rendering for long documents. Keep source/date and alternate values attached to the text they qualify. Preserve readable raw/source access.

**Acceptance:** Code fences, lists, links, and tables remain readable; a hundreds-section document does not mount all detail indiscriminately; keyboard focus survives collapsing/windowing.

### 6. P2 — Home and onboarding emphasize administration before useful work

**Evidence:** Installed Home leads with Connect, followed by Needs Attention, totals, cascade order, and source health. The public demo omits the desktop Connect panel and starts with maintenance. The first-run wizard introduces personal/team/company stages. [FIRST_PROMPT](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/connect-agent.ts#L37) asks the agent to inventory concepts rather than answer a concrete development question.

**Change:** Make the first journey: choose a project folder → preview what was found → connect a client → ask a useful project question → inspect evidence. Keep additional layers optional. After activation, Home should prioritize project search, recent useful decisions, last agent retrieval, and a small set of relevant changes. Keep health and review reachable without making them the main reason to open the app.

**Acceptance:** Measure time to first sourced answer and completion of each step; target a first successful workflow within five minutes in moderated sessions. Do not mistake finishing the wizard for activation.

### 7. P2 — Project scoping exists in the engine but is absent from the main workflow

**Evidence:** The profile CLI already creates profiles and maps project paths. MCP selects from explicit profile or working directory. The inspected console lacks a project/profile selector. The global connection instructions do not help the user verify the project mapping a client actually selected. Source rank is also presented as Personal/Team/Company even for arbitrary documentation folders.

**Change:** Add a visible project selector and setup for folder-to-profile mappings, with a preview of included sources and precedence. Put actual source names before inferred organizational labels. Show the selected project in client diagnostics. Use explicit profile configuration where client launch-directory behavior is uncertain.

MCP roots are a possible integration signal for compatible clients, not a universal guarantee or a security boundary; assess client support before adopting them. [MCP roots specification](https://modelcontextprotocol.io/specification/2025-06-18/client/roots)

**Acceptance:** Two repositories with conflicting standards reliably select their intended context. The UI and connected client disclose the same selection, and switching does not re-index unchanged sources unnecessarily.

### 8. P2 — Add-source success can demonstrate the wrong source

**Evidence:** Both added sources displayed “Your agent can now read: CHANGELOG,” an existing personal concept, while the new source was still scanning. [SetupWizard.tsx](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/components/SetupWizard.tsx#L880) selects `graph.concepts[0]` without checking its contributor.

**Change:** Pick a concept contributed by the newly added source, wait for an actual indexed result, and offer “Open this result.” Until then, state that indexing is in progress. Keep the existing per-source progress display.

**Acceptance:** The example always traces to the source just added, including failed, empty, and slow-source cases.

### 9. P2 — Narrow provenance and conflict rows squeeze the content

**Evidence:** At 390 px, the public demo had no page-wide overflow, but Personal/Team/Company pills split across letters and “Primary database” broke into tiny fragments. Dates and Open file actions retained fixed space. Open file controls measured about 22 px high; primary toolbar controls were around 32 px.

**Change:** Stack source/date/actions under section headings at narrow widths, let dissent text occupy its own row, and increase touch hit areas. For small Mac windows, prioritize the reader over the persistent sidebar. Do not treat desktop 32 px controls as automatically invalid under WCAG; assess spacing and target-size exceptions separately.

**Acceptance:** Verify 390 px demo, 760–900 px desktop windows, enlarged text, keyboard navigation, and long source names. No mid-word metadata wrapping that makes provenance unreadable.

### 10. P2 — Remote indexing cancellation does not bound abandoned work

**Evidence:** [Index queue notes](../architecture/notes/index-queue-and-memory.md) and adapter inspection confirm that remote listing does not consume the indexing abort signal. A timed-out pass can release its queue slot while the underlying remote scan continues. GitHub requests have their own timeout, which is a different boundary.

**Change:** Propagate cancellation through listing, pagination, fetches, and MCP request lifecycles; deduplicate retries while cleanup is pending. Add failure-injection tests for slow, stalled, and repeatedly retried sources.

**Acceptance:** Active underlying remote work remains bounded after cancellation and retry. No stale pass can publish into a newer source generation. This risk was code-confirmed, not reproduced against a real remote account during this audit.

### 11. P2 — Secondary UI and demo data load with the initial shell

**Evidence:** [App.tsx](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/App.tsx#L1) eagerly imports views/dialogs; [api.ts](https://github.com/ContextCake/context-cake/blob/191a40418dd1e77f7e7167878292ec22729f82d5/apps/console/src/api.ts#L13) statically imports the demo bundle. The public demo loaded one approximately 572 KB decoded JavaScript entry and 166 KB stylesheet.

**Change:** Split Settings, Review, Canvas, connection setup, and demo-only data where bundle analysis shows a material win. Prefetch likely destinations after the shell is interactive. Expand measurement to packaged startup, first interaction, and idle memory before assigning priority to deeper runtime work.

**Acceptance:** Compare cold start and first-navigation latency before/after, with a documented asset budget. This is lower priority than the measured MCP delay. Electron recommends measuring real workloads and avoiding blocking work; it does not imply a framework rewrite. [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)

## Changes most likely to increase sustained use

### First: make an agent connection demonstrably useful

Ship findings 1–4 and 8 as the first focused effort. The user should see one real project answer, its supporting source, and an observed successful client request. Add a local connection diagnostic with recovery actions and a `doctor`-style CLI surface. Connection detection and last-use evidence are new work; do not present the existing copy-command flow as that capability.

### Next: make daily retrieval effortless

Ship project/profile selection, evidence-rich search, and readable concept detail. Add pinned decisions, recent questions, and a project brief assembled from explicitly chosen sources with a token budget. Keep source links and conflicts visible in exported context. A brief should help start work, not dump the entire knowledge base into every session.

### Then: close the learning loop without creating a second inbox

Build on the existing capture, promotion, telemetry, and discrepancy-rule mechanisms. Offer a compact end-of-task decision capture with a preview of its destination and diff, explicit approval before team sharing, and deduplication against existing decisions. Make retrieval of that capture in a later session visible. Surface changes relevant to the active project, with clear actions; avoid generic daily notifications and engagement counters.

The return loop is: **use a sourced decision → improve or record it → find it in the next task**. Success may mean fewer visits to the desktop UI because ContextCake reliably serves the developer's agent.

## Measurement plan

- **Activation:** first source successfully indexed, first client tool call, first successful source read, and user-confirmed useful answer. Track time between these separately.
- **Retention:** activated developers with useful retrievals on another day at D7 and D30. Raw tool-call count is insufficient because retries and poor searches inflate it.
- **Usefulness:** zero-result searches, reformulations, source opens after retrieval, captures reused in later sessions, and false-alert dismissal reasons.
- **Performance:** packaged cold/warm startup, MCP first/warm search p50/p95, resolve latency, source-add-to-searchable time, one-file refresh, idle CPU/RSS, and behavior under remote failure.
- **Consent:** start with local diagnostics and optional aggregated measurement. Existing team telemetry is not automatically an adoption funnel. Do not upload prompts, documents, file paths, or concept IDs as product analytics.

Use five developers with their own repositories for an initial moderated pass, then a two-week dogfood period. Observe them completing a real task without teaching the cascade model first. Keep a holdout set of natural questions and unanswerable questions; the 38-question eval remains a regression gate, not the adoption experiment.

## Keep these strengths

- Local-first operation and CLI access with the app closed.
- Engine isolation, bounded asynchronous work, incremental snapshots, compact graph transport, narrow store subscriptions, and existing virtualized file/review lists.
- Visible dissent, source provenance, recoverable writes, and explicit capture/promotion review.
- Familiar Mac shell, keyboard affordances, semantic theme tokens, and contrast tests.
- Honest simulation labeling and no silent live-to-demo fallback.

Suggested design passes: `$impeccable harden` for search/setup states and link-review correctness; `$impeccable onboard` for first value; `$impeccable optimize` for measured retrieval/rendering work; `$impeccable layout` for reader/provenance responsiveness; `$impeccable polish` last. Re-run the audit after fixes, prioritizing measured task success over increasing the score.
