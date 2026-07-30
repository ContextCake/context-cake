---
type: runbook
title: Running a backfill
description: How to reprocess a historical window without taking down the live pipeline.
tags: [backfill, reprocessing, pipeline]
updated: 2026-06-14
---

## Before You Start {#before}

Backfills compete with the live job for cluster capacity and for Kafka broker throughput. Announce the window in the team channel and run outside the daily peak.

## Isolation {#isolation}

Run the backfill as a separate application with its own consumer group and its own checkpoint directory. Never reuse the live job's checkpoint: reusing it rewinds production.

## Rate Limiting {#rate}

Cap the backfill with `maxOffsetsPerTrigger`. An uncapped backfill reads the entire retention window in one micro-batch, blows the executor heap, and pages whoever is on call.

## Verification {#verify}

Compare row counts and a checksum for the reprocessed window against the source before deleting the old partition. A backfill that silently drops rows looks identical to a successful one until someone asks about a number three weeks later.
