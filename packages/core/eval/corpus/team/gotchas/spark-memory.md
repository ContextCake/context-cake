---
type: gotcha
title: Spark executor out-of-memory failures
description: Why executors die during joins and shuffles, and what actually fixes it.
tags: [spark, memory, oom, shuffle, skew]
updated: 2026-07-05
---

## Symptom {#symptom}

Executors are killed mid-stage with exit code 137 and the stage retries until the job fails. The driver log blames the container, which is misleading: the container was killed by the node, not by Spark.

## Usual Cause {#cause}

Data skew in a join key. One partition holds most of the rows, that single executor exceeds its container limit, and the node reaps it. Raising executor memory moves the failure later without preventing it.

## Fix {#fix}

Salt the skewed key or enable adaptive query execution with skew join handling. Repartitioning before the join helps only when the skew is mild.

## What Does Not Help {#not}

Increasing `spark.executor.memory` past the node's allocatable ceiling causes the scheduler to refuse the request instead, which reads as a hang. Disabling off-heap does nothing for a skew problem.
