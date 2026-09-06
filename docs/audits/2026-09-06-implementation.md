# Performance and trustworthy resolution implementation

The first implementation of both approved workstreams is combined on `codex/performance-trustworthy-resolution`. This record separates measured improvements from remaining product work.

## Performance and everyday use

- MCP retains a bounded, profile-specific index. Repeated and distinct local searches validate fingerprints without rereading unchanged documents; one edit costs one document read. Idle retention is bounded and concurrent refreshes coalesce.
- A 3,000-document / 92.1 MB benchmark measured an old full rebuild at 4,348 ms and warm real stdio searches at 21–22 ms. Two independent clients after one edit answered in 35 ms total. Hit ordering and scores were asserted identical. Cold retained search still took 4,491 ms; this is not a cold-start improvement.
- Remote listing/fetch waits receive cancellation signals. A foreign MCP server may ignore protocol cancellation and continue its own work.
- Knowledge search distinguishes pending, failed, partial and empty results; shows source names and snippets; and windows the document list. The reader renders safe Markdown and pages long sections with navigation controls.
- Source onboarding proves value from the newly added source. Ask provides an honest handoff to a connected external agent. Home offers direct search.
- Responsive reader/provenance layouts were checked at 1,280, 900 and 390 pixels. Settings, Connect, Canvas and Review load on demand. The resulting 434.37 KB decoded entry is about 24% smaller than the audit's 572 KB observed entry, despite the new controls; this is a payload comparison, not a measured startup-latency improvement.

## Automatic resolution

The [approved spec and implementation design](../../specs/contextcake-automatic-resolution/design.md) define exact source-preserving section policies, current-evidence checks, history, pause, Undo and HTTP/MCP delivery. The local-model path is advisory only and uses installed Ollama models on demand.

Link detection and edits now share lossless Markdown spans, ignoring code examples and escaped syntax. Indexing warnings prevent incomplete coverage from enabling automatic choices. GitHub content dates use author history rather than committer dates or repository activity.

The local model smoke trial exposed two errors in six synthetic cases. Model-driven automatic selection remains unqualified and disabled. The decision system never uses a model's confidence as authority.

The installed production app and its real sources have not been replaced by this branch. Implementation testing uses isolated source fixtures and the development renderer. The original [installed-app audit](./2026-09-06-performance-and-ux.md) remains the baseline.

## Verification

- Full engine gate: 57/57 suites passed, with targeted reruns after final review fixes.
- Console: 42 suites / 736 tests, typecheck and live build passed.
- Desktop: 125 tests passed on Node 22; isolated boot smoke passed.
- Desktop isolation: main-process lag 13 ms while indexing 3,000 documents; engine status p95 11 ms over 45 probes.
- Node 22 focused engine/transport regressions passed. Existing retrieval quality baseline remained unchanged.
- Real browser policy enable → selected reader answer → zero actionable review items → Undo → reopened review cycle passed. Both source files remained byte-identical.
- Installed Ollama 0.15.4 rejected an oversized synthetic prompt with HTTP 400 when truncation and context shifting were disabled.
- Code/security/documentation review fixes include parser denial-of-service bounds, content-health coverage, mixed-response revision checks and selected-profile MCP binding.
