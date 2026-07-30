---
type: standard
title: Observability standard
description: What a streaming job must emit, on top of the org baseline.
tags: [monitoring, metrics, lag, alerts]
updated: 2026-06-08
---

## Metrics {#metrics}

Request rate and latency percentiles are meaningless for a batch job. Streaming jobs export consumer lag, micro-batch duration, input rows per trigger, and checkpoint age instead.

## Alerting {#alerting}

Alert on consumer lag exceeding fifteen minutes and on checkpoint age exceeding three trigger intervals. Do not alert on individual task failures; Spark retries them and the noise trains people to ignore the channel.
