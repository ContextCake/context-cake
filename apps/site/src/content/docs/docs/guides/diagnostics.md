---
title: Diagnostics and Local Grafana
description: Inspect source health and retrieval locally, with optional Docker-backed dashboards and traces.
---

**Availability:** beginning with version 0.9.0, the [Web Demo](/demo) includes a
clearly labeled, read-only sample of the native overview. The signed Mac app
includes the live view and Local Grafana controls. [Download it from the Install
page](/install).

## Native diagnostics

Open **Diagnostics → Overview** in the Mac app (⌘6). The view shows current source
health, indexing activity, memory pressure, and recent search/read observations.
It reads existing engine state, never scans your documents to populate a chart.

Retrieval observations include which search backend answered (persisted store or
in-memory), whether each search was cold (it had to analyze or load documents) or
warm (it answered from an already-current index), how many candidates it scored,
and how long it took to sync the index before scoring. The overview also shows
cold/warm counts and median durations for the current window.

The observation window contains at most 200 events from the last 15 minutes in
this desktop engine. It resets when the engine restarts. Sample counts and the
actual observation interval are displayed. P95 requires at least 20 observations
per operation. A dash means insufficient data, not zero latency or zero failures.
Pause updates to inspect a moment, filter operations, or use compact rows. Updates
run every five seconds while the view is visible. These summaries do not include
other processes or uninstrumented clients.

## Local Grafana — Experimental

For detailed dashboards and traces, choose **Enable Local Grafana**. Docker Desktop
must already be installed. Setup downloads the pinned `grafana/otel-lgtm` image;
it can take several minutes and uses additional disk, CPU, and memory. ContextCake
never installs Docker. If Docker is stopped, choose **Start Docker**, wait for it
to open, and choose **Start Grafana**.

Once enabled, ContextCake starts its owned container asynchronously on launch when
Docker is running. App startup and retrieval never wait for telemetry. **Stop**
ends collection and retains history; **Restart** reuses it. **Disable** prevents
automatic startup. **Clear local history…** requires confirmation and removes only
the owned telemetry container and volume. Running exporters discard pre-clear
totals and trace-link evidence; normal restarts preserve them. Normal app quit stops the owned container.
A subsequent launch reconciles it after a crash without creating duplicates.

The stack has a two-CPU, 2 GB memory ceiling, rotating container logs (two 5 MB
files), and 24-hour telemetry retention policies. Backend retention is periodic;
it is not a guarantee that every byte disappears exactly 24 hours after ingestion.
The volume persists until you explicitly clear it.

## Dashboards and traces

**Diagnostics → Grafana** embeds the provisioned dashboard with time-range controls
and matches the app's light/dark appearance. **Open in browser** opens the managed
loopback instance. Recent native operations offer **Trace** after export succeeds. Collector
acceptance precedes backend indexing, so a trace may take a moment to appear.
Native delivery counters measure collector acceptance, not durable backend storage;
the dashboard also shows collector-to-backend delivery failures.

The dashboard groups operations by desktop/MCP process role. Restart existing MCP
clients after enabling telemetry and use the packaged `contextcake mcp` launcher.
Running the source-only MCP server directly remains supported; it does not install
or enable an exporter. Uninstrumented clients are not represented.

## Privacy and limits

Telemetry includes closed operation/outcome labels, timings, counts, stable error
codes, opaque process/trace identifiers, and closed retrieval labels (search
backend, cold/warm phase, candidate count, index sync time). It excludes prompts,
document content, source paths, credentials, and raw exception messages. Native diagnostics can show
local source names and the engine's local activity log; those are not exported.

Local Grafana uses loopback-only dynamic ports and anonymous Viewer access. Other
processes on your Mac can reach those ports. The iframe has no ContextCake bridge
or bearer token. Only telemetry storage and read-only provisioning are mounted;
knowledge folders and the Docker socket are not mounted. Usage reporting and Cloud
forwarding are disabled in this stack. Image downloads contact the image registry.
The app's existing release checks and optional account sync are separate settings.

The exporter uses standard OTLP/HTTP with bounded queues (512 observations per
process) and two-second request deadlines. Delivery is best effort: unavailable or
full backends drop observations rather than blocking retrieval. This development
stack is [documented for local development/testing](https://github.com/grafana/docker-otel-lgtm),
not production hosting. Alloy, Grafana Cloud, and remote exporters are future work.

## Headless checks

```bash
contextcake doctor --json
contextcake doctor --manifest ./layers.json --profile default
```

This performs a **fresh configuration check**, reporting the manifest and any
invalid layers, the selected profile, manifest revision, effective limits, folder
and remote source availability, writable config/data/cache folders, every
`contextcake` on `PATH` with the version its install files record, and local collector availability through
the desktop launcher. Source checks are capped at the first 100 configured sources
or 15 seconds and do not read the corpus. Executable (MCP) sources are never started,
and keychain-credential sources are not contacted; both are marked not probed. It does not read the running app's private observation
history.

Exit codes: `0` healthy check, `8` a failed check (including a missing manifest),
`2` invalid arguments, and `6` timeout, or incomplete coverage with
`--require-complete`. Unhealthy results have `data: null`, the diagnostic report in
`error.details`, and fix commands in `nextActions`.
The JSON envelope includes `schemaVersion`,
`ok`, `command`, `context`, `data`, `warnings`, and `nextActions`.
