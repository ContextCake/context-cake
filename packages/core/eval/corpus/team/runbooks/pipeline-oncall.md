---
type: runbook
title: Pipeline on-call
description: First response when a streaming job stalls, lags, or dies overnight.
tags: [oncall, pipeline, lag, spark, kafka]
updated: 2026-07-02
---

## Triage Order {#triage}

Check consumer lag first, then the driver logs, then upstream producer health. Most overnight pages are a lag alert caused by an upstream producer burst, not by anything wrong in our job.

## Stalled Job {#stalled}

A job that shows zero progress for more than ten minutes is stalled. Restart the driver before investigating: a stalled Structured Streaming query almost never recovers on its own and the checkpoint makes the restart safe.

## Growing Lag {#lag}

If lag grows steadily but the job is healthy, the job is under-provisioned rather than broken. Raise executor count first; raising memory per executor rarely helps a throughput problem.

## When To Escalate {#escalate}

Escalate to the platform team if brokers are unreachable or the schema registry is down. Do not escalate for a single failed micro-batch; the retry handles it.
