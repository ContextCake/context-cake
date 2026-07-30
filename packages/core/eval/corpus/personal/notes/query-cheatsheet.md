---
type: note
title: ClickHouse query cheatsheet
description: Query shapes I keep forgetting.
tags: [clickhouse, sql, queries]
updated: 2026-06-27
---

## Time Buckets {#buckets}

`toStartOfInterval(ts, INTERVAL 5 MINUTE)` for bucketing. `toStartOfFiveMinute` also exists but does not generalize, so I stopped using it.

## Approximate Counts {#approx}

`uniqCombined` is close enough for dashboards and dramatically cheaper than `uniqExact`. Use the exact variant only when someone is going to reconcile the number against finance.

## Debugging A Slow Query {#slow}

`EXPLAIN indexes = 1` shows whether the primary index was used. Nine times out of ten a slow query is a filter that does not match the sort key prefix.
