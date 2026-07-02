---
type: decision
title: Primary database
updated: 2026-06-28
owner: me
tags: [database, local-dev]
---

# Primary database

## Choice {#choice}

Postgres in every shared environment. Locally I run SQLite for the test suite so I
can reset state per-run without a container. Never commit SQLite-only assumptions.

## My notes {#notes}

The ClickHouse ETL job is flaky on my branch — see the deploy runbook rollback step
before blaming the query.
