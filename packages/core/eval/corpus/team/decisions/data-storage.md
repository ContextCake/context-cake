---
type: decision
title: Primary datastore standard
description: Where the data platform team keeps state, including the analytics exception.
tags: [database, clickhouse, storage]
updated: 2026-06-22
---

## Transactional Store {#transactional}

PostgreSQL 16 for pipeline metadata and job bookkeeping, matching the org default. Nothing controversial here.

## Analytics {#analytics}

ClickHouse is our analytical store, not the central warehouse. Interactive queries over the event stream need sub-second response and the warehouse cannot do that at our cardinality. The warehouse remains the system of record for finance-facing reporting.
