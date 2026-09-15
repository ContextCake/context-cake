---
type: runbook
title: Database migration guide
description: How to plan, write, test, and roll out a schema migration safely.
tags: [migration, database, schema, runbook]
updated: 2026-07-10
---

## Overview {#overview}

This is the step-by-step process for taking a schema migration from a local branch to production. Follow it in order; skipping steps is how a migration takes down the primary.

## Planning {#planning}

Write the migration plan in the PR description before writing any SQL: what changes, why, and what the rollback looks like if it fails partway through.

## Writing the Migration {#writing}

Migrations are forward-only. Prefer additive changes — a new nullable column, a new table — over destructive ones. A destructive change needs a two-release deprecation window, same as the org standard.

## Testing Locally {#local}

Run the migration against a seeded local database and confirm the application still boots against the new schema before opening a PR.

## Staging Rollout {#staging}

Apply the migration to staging first and let it sit for at least one full deploy cycle before it ever touches production.

## Sign-off for Large Migrations {#signoff}

A migration touching more than three tables in one change needs a second engineer's sign-off in the PR, separate from and in addition to the usual code review approval.

## Lock Timeouts {#locks}

Set an explicit `lock_timeout` of 45 seconds on every migration statement that takes a table lock. If a statement cannot acquire the lock inside that window, it aborts and rolls back automatically instead of queuing behind live application traffic.

## Renaming a Column Mid-Migration {#rename}

Never rename a column in the same migration that also changes its type. Split it into three releases instead: add the new column, dual-write to both, then drop the old one once callers have moved.

## Monitoring After Rollout {#monitoring}

Watch replication lag and lock wait metrics for the first hour after a production migration lands; a slow migration on the primary shows up there before it shows up anywhere else.
