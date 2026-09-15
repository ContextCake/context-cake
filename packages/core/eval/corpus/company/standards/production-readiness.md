---
type: standard
title: Production readiness checklist
description: What a service must have in place before it takes production traffic.
tags: [readiness, launch, checklist, standard]
updated: 2026-07-01
---

## Health Checks {#health}

Every service exposes a liveness and readiness endpoint before its first production deploy. The readiness endpoint must reflect real dependency health, not just process uptime.

## On-call Coverage {#oncall}

A service cannot go live without a named on-call rotation in the alerting rotation. A single-owner rotation is acceptable at launch but must grow past one person within a quarter.

## Dashboards {#dashboards}

A service needs a dashboard covering request rate, error rate, and latency before it is considered production ready. Link the dashboard from the service's own index entry.

## Rollback Plan {#rollback}

Document how to roll back the service to its last known good version, and confirm the rollback path has actually been exercised, not just written down.

## Owner of Record {#owner}

Every production service has a named owning team recorded in the service catalog. An unowned service is not eligible to take production traffic.
