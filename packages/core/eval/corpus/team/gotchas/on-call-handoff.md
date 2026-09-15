---
type: gotcha
title: On-call handoff gaps
description: Why a new service sometimes has no real on-call coverage even after launch.
tags: [oncall, handoff]
updated: 2026-07-08
---

## Symptom {#symptom}

An alert fires for a service and nobody on the current rotation recognizes it. The service shipped without ever being added to the alert rotation.

## Root Cause {#cause}

The team skipped the [production readiness checklist](../standards/production-readiness.md) on-call section during a rushed launch, so the rotation was never created.

## Fix {#fix}

Treat the checklist as a merge gate for the launch PR, not a follow-up task.
