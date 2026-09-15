# Local diagnostics verification

Local verification on an Apple Silicon Mac, 2026-09-14. This is an unsigned local
source build, not a signed release or public deployment. Docker Desktop 27.5.1;
Node 22.22.2 for repository checks. The test profiles and sources are disposable
copies; the developer's normal app configuration and knowledge folders were not used.

## Automated gates

- Engine: 59/59 suites pass, including the unchanged retrieval evaluation.
  Golden set: 38 questions; recall@1 0.895, recall@5 1.000, MRR 0.947,
  conflict coverage 1.000. New diagnostics and policy tests also pass after fixes.
- Desktop: 143/143 tests pass, covering lifecycle/ownership, CLI dispatch, bounded export and trust-boundary tests.
  A real nonresponding HTTP collector verifies two-second export deadlines and a
  10,000-event burst remains bounded at the configured queue capacity.
- Console: 769/769 tests across 43 files pass, including diagnostics empty data, nullable failed-source totals, percentile samples,
  frame URL restrictions, demo isolation and paused/unmounted polling have regression
  coverage. Activity bins, unavailable observations, same-instant samples and accessible
  interval counts are also covered. Full console tests, typecheck and build pass.
- Site: 41-page build plus existing install/commerce gates pass. No public deployment performed.

## Real stack and Mac app

Verified with the pinned image and app-owned loopback bindings:

- Packaged MCP search and read each appear as real `role="mcp"` Prometheus series.
  Packaged doctor reports a valid profile, effective limits and available collector.
  Packaged smoke returns authenticated API 200 / unauthenticated 401, with no failed probes.
- Native view, source warnings/recovery, measured reads/searches, sample counts,
  compact/comfortable controls, light/dark appearance and narrower window layout.
- Anonymous Viewer dashboard and a dedicated read-only trace dashboard. The native
  trace action opens a real exported operation; it does not depend on Explore or
  administrator access. Failed index trace contains a stable error code.
  Embedded log details preserve correlation IDs; trace navigation uses the native
  operation action. Grafana's external derived links request a popup, so they are
  omitted inside the sandbox rather than exposing a blocked action.
- A temporary folder rename produces an index failure and coverage warning; restoring
  it returns the source to ready. A nullable document total initially exposed a render
  bug; the fix is covered by a live-mode component test and rechecked in the Mac app.
- Disabled setup, Docker stopped, download failure, slow readiness, container failure,
  quit during download, relaunch/adoption and duplicate prevention have deterministic
  lifecycle tests. Real start/stop/restart/quit and retained history are exercised
  against Docker. Docker was not deliberately shut down system-wide for these tests.
- One exported trace returned HTTP 200 before and after a normal stack restart;
  after explicit clearing/recreation, the old trace returned 404. Only the test
  stack's labelled volume/container were removed. Retention configuration is checked;
  this session is not a 24-hour retention soak.
- Runtime inspection confirms dynamic 127.0.0.1 bindings, the owned data volume and
  read-only provisioning mounts; no knowledge folder or Docker socket is mounted.
  Trusted-window tests reject Grafana and same-origin subframes for native IPC.

## Overview design

The native Overview follows the dashboard hierarchy recommended in
[Grafana's dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/):
retrieval volume, errors and duration first, then source coverage and operation
inspection, followed by resource and local-stack controls. The activity chart
reports retained observation counts rather than implying a complete request rate.
Search and read duration remain separate; P95 requires 20 samples for each.

Summary cells share a baseline and use tabular numbers. Activity and performance
panels sit together at wider sizes and stack in narrower windows; source and
operation tables use the full content width. Color distinguishes series and
attention states, with labels and an accessible interval table providing the
same information without color or pointer hover. Native light/dark themes,
compact/comfortable rows and pause controls remain available.

## Review corrections

Independent review prompted three fixes: quitting still stops the owned container
when saving preferences fails; histogram bounds cover supported long index passes;
and undone policies do not emit stale/blocked diagnostic events. Regression tests
cover each. CI also prompted a compatible js-yaml security patch and strict
allowlisting/encoding of embedded-dashboard time range and theme parameters.

## Incremental walkthrough

`node examples/local-diagnostics/run.mjs` creates two temporary documents, searches,
edits one, forces a source failure, restores it and cleans up. With
`--telemetry-config <local-observability.json>`, the same real engine events export
into the managed stack. The edit reads one document and reuses one. Backend query
names were verified against actual Prometheus series; empty metric records are
omitted because Prometheus rejects those requests (notably MCP-only batches).

## Performance evidence

Same existing retained-search benchmark, 3,000 documents / approximately 92 MB,
Node 22. Each mode has one cold sample and three warm samples; this is a directional
local check, not a statistically powered overhead estimate.

| Measurement | Without observation wrapper/export | With observation wrapper/export |
| --- | ---: | ---: |
| Cold retained search (1 sample) | 4753.93 ms | 4805.19 ms |
| Warm retained search (3 samples) | 22.36 / 20.02 / 18.87 ms | 22.70 / 19.96 / 19.59 ms |
| Search after one edit (1 sample) | 24.82 ms | 25.85 ms |
| Documents read after edit | 1 | 1 |

Ranking is identical. The direct retained-search comparison toggles the diagnostic
wrapper and optional adapter; existing stdio child measurements in that benchmark
have core instrumentation in both modes and are not an instrumentation-off comparison.

The existing 3,000-document app isolation gate measured main-process lag 9 ms;
engine status p50 7 ms, p95 12 ms, max 14 ms over 43 probes while indexing.
A separate full-index responsiveness run recorded 60 status samples: p50 1.72 ms,
p95 2.98 ms, max 3.57 ms. These are different probes/workloads, not interchangeable.

One settled container sample: 4.31% CPU and 581.9 MiB of its 2 GiB ceiling.
This is a sample, not peak memory or a long-run resource guarantee.

## Interpretation and follow-ups

Collector HTTP acceptance is not proof of durable downstream storage. Native
sent/queued/dropped counters describe the adapter-to-collector hop; Grafana also
shows collector exporter failures. Backend outages cannot report themselves live
through the unavailable backend. Recent native trace links can precede indexing.

Full production hosting, Alloy/Cloud, warehouse access, dbt import, source/settings
CLI administration, signed release, deployment and a long retention soak remain
outside this increment. The dbt assessment is explicitly exploration-only.
