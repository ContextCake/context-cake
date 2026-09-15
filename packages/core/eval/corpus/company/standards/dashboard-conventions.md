---
type: standard
title: Dashboard conventions
description: Layout and naming rules for service dashboards.
tags: [dashboards, observability, standard]
updated: 2026-06-28
---

## Naming {#naming}

Name a dashboard after the service, not the team. `checkout-api`, not `payments-team`.

## Required Panels {#panels}

Every dashboard needs request rate, error rate, and latency panels above the fold; this is the same bar the [production readiness checklist](production-readiness.md) sets for launch.

## Ownership {#ownership}

The dashboard link lives on the service's own index entry, never only in a wiki that can drift out of date.
