---
type: decision
title: Primary database
updated: 2026-06-20
owner: Data
tags: [database, architecture, analytics]
---

# Primary database

## Rationale {#rationale}

Postgres for OLTP, yes — but we added ClickHouse for analytics after the reporting
queries started locking the primary. The org "one datastore" line no longer matches
what we actually run.

## Analytics store {#analytics}

ClickHouse, self-hosted on the data cluster. It is a read replica target, never a
source of truth. Nightly ETL loads from Postgres.
