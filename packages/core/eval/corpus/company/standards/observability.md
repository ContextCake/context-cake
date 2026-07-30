---
type: standard
title: Observability standard
description: Required logging, metrics, and tracing for every production service.
tags: [logging, metrics, tracing, monitoring, alerts]
updated: 2026-04-28
---

## Structured Logging {#logging}

Logs are emitted as structured JSON with a request identifier on every line. Free-text logging without a correlation field is not acceptable in production code.

## Metrics {#metrics}

Every service exports request rate, error rate, and latency percentiles. Dashboards are generated from the shared template rather than hand-built per team.

## Tracing {#tracing}

Distributed tracing is enabled by default with head-based sampling at one percent. Raise the sample rate temporarily during an investigation, then put it back.

## Alerting {#alerting}

Alerts fire on symptoms customers feel, not on causes. An alert that nobody acts on is deleted rather than muted.
