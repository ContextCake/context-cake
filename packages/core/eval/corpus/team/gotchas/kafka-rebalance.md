---
type: gotcha
title: Consumer group rebalance storms
description: Why consumers thrash on deploy and how to stop the repeated rebalancing.
tags: [kafka, rebalance, consumer, timeout]
updated: 2026-06-19
---

## Symptom {#symptom}

After a deploy, the consumer group rebalances continuously. Throughput collapses and lag climbs even though every instance looks healthy.

## Usual Cause {#cause}

`max.poll.interval.ms` is shorter than the slowest batch takes to process. The coordinator decides the member is dead, revokes its partitions, and the member rejoins mid-batch, which triggers the next rebalance.

## Fix {#fix}

Raise `max.poll.interval.ms` above the worst-case batch duration, or lower `max.poll.records` so a batch finishes inside the interval. Use cooperative sticky assignment so a rejoin does not stop every other consumer.
