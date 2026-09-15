# Local diagnostics and optional Grafana

Status: shipped in the signed Mac app and public Web Demo beginning with 0.9.0.

## Product outcome

Help a Mac user see which sources need attention, whether retrieval is responding,
and what indexing actually did. Native Diagnostics works without Docker. Optional
**Local Grafana — Experimental** adds retained dashboards and individual traces.
The public Web Demo never connects to a visitor's localhost.

## Boundaries

- Core stays dependency-free. `contextcake.diagnostics.v1` is a closed Node
  diagnostics-channel schema shared by the HTTP engine and MCP server.
- The desktop-owned adapter exports standard OTLP/HTTP JSON. Operation/outcome/
  process-role labels are bounded; paths, prompts, content, credentials and raw
  errors are excluded. Identifiers are opaque and belong in traces/resources.
- Native summaries describe this engine's bounded 200-event/15-minute window.
  Grafana describes participating desktop/MCP processes. Neither observes other
  clients. Unknown sample statistics remain unknown; p95 needs 20 native samples.
- Retrieval never awaits export or Docker. Export queues are bounded at 512
  observations per process, requests at two seconds, collector queues at 256
  batches with a memory limiter. Failed delivery is lossy and visible.
- Device-local preferences live beside the app configuration, outside manifests,
  profile sidecars and account sync. Existing packaged MCP clients should restart
  after enabling; the adapter refreshes non-secret endpoint configuration to
  survive stack restarts. Direct source-only MCP remains usable without export.

## Local stack

Use the version-and-digest-pinned `grafana/otel-lgtm` image and its included
collector. Local development/testing is its documented scope. No remote forwarding
or backend usage reporting is enabled. Future Alloy/Cloud work must preserve OTLP.

Disabled by default. Setup explains the image download; it never installs Docker.
If enabled, app launch starts only the owned container, asynchronously. A stopped
Docker daemon yields an explicit Start Docker action; it is never auto-launched.
States distinguish disabled, downloading, starting, ready, stopped, Docker stopped
and failed. Stop/quit preserve the labelled volume; explicit confirmed clearing
removes only that container/history. Reconcile owned containers after crashes and
serialize transitions to prevent duplicates or a late container after quitting.

Bind only Grafana and OTLP HTTP to dynamic 127.0.0.1 ports. Mount only telemetry
storage and read-only provisioning. Limit the container to two CPUs/2 GB, rotate
container logs, and configure 24-hour retention (periodic backend cleanup).

## UI and trust

Diagnostics is a normal app destination with Overview/Grafana tabs. Overview
reuses status and indexing observations through a read-only engine endpoint; it
never scans documents for charts. Poll only while visible, support pausing, show
window/sample counts, and use restrained typography, aligned numeric columns,
responsive layout and comfortable/compact density.

Grafana is an on-demand, cross-origin sandboxed iframe restricted to the managed
origin. Anonymous access is Viewer; signup, login form and initial admin creation
are disabled. No ContextCake bearer/preload/native capabilities enter the frame.
All native IPC rejects subframes; frame navigation and redirects are restricted.
Host controls select known dashboard/trace routes, range and theme. Opening in a
browser cannot accept an arbitrary renderer-supplied URL.

## Headless and documentation

`contextcake doctor [--manifest ...] [--profile ...] [--json]` performs a fresh,
bounded configuration/folder check and reports effective limits and local collector
availability. It uses the control-plane envelope and exit categories; it does not
read a running engine's history or execute remote/executable sources. Full source,
settings and query administration remain later increments.

README, homepage and privacy/docs describe the same shipped source-build behavior.
Explain authoritative files versus indexes/caches/clones, and precedence versus
factual confidence or authorization. Data-catalog positioning must avoid unsupported
competitor claims. dbt is a design assessment only: no importer/warehouse/graph store.

## Acceptance

- [x] Deterministic event/redaction/bounds tests; unchanged retrieval evaluation.
- [x] Desktop and packaged MCP events reach the real managed backend.
- [x] Lifecycle failure tests, restart/quit ownership and history preservation.
- [x] Native warning/recovery, iframe dashboard/trace, themes, resizing and keyboard access in the packaged app.
- [x] Loopback ports, allowed mounts, trusted IPC and navigation isolation.
- [x] Unresponsive/full telemetry cannot block retrieval or grow queues unboundedly.
- [x] Same-fixture performance comparison, sample counts and container resource sample.
- [x] Doctor contracts and reproducible temporary failure/recovery walkthrough.
- [x] Engine tests/eval, console tests/typecheck/build, desktop tests/package/isolation smoke, site build.
- [x] Accurate documentation, dbt note and reviewable PR; no deployment or signed release in this increment.

Evidence and any remaining limits: [verification.md](verification.md).
