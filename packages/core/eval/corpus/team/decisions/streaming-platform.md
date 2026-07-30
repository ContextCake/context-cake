---
type: decision
title: Streaming platform
description: Kafka topic conventions, partitioning, and delivery guarantees for the pipeline fleet.
tags: [kafka, streaming, topics, partitions]
updated: 2026-06-30
---

## Broker Platform {#broker}

Managed Kafka, three brokers per environment. We evaluated Pulsar in 2025 and stayed on Kafka because the operational tooling and our existing consumer code were both already there.

## Topic Naming {#topics}

Topics are named `<domain>.<entity>.<event>.v<major>`. A schema-breaking change gets a new major and a parallel topic; consumers migrate and the old topic is retired after thirty days.

## Partitioning {#partitioning}

Partition by entity identifier so per-entity ordering holds. Do not partition by timestamp: it produces hot partitions during backfills and destroys ordering guarantees the downstream joins rely on.

## Delivery Semantics {#delivery}

At-least-once delivery with idempotent writes downstream. Exactly-once is available in the Kafka transactional API but we do not use it; the throughput cost is real and every consumer we own is already idempotent.
