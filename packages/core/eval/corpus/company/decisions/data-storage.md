---
type: decision
title: Primary datastore standard
description: Which database a service should use for transactional state.
tags: [database, storage, standard]
updated: 2026-05-20
---

## Transactional Store {#transactional}

PostgreSQL 16 is the default database for service state. Managed instances are provisioned through the platform portal; teams do not run their own.

## Caching {#caching}

Redis for ephemeral cache only. Nothing that cannot be rebuilt from the primary datastore may live in Redis.

## Analytics {#analytics}

Analytical queries run against the warehouse, never against a service's production database. Read replicas exist for operational debugging, not reporting.

## Migrations {#migrations}

Schema changes ship as forward-only migrations reviewed by the owning team. Destructive column drops require a two-release deprecation window.
