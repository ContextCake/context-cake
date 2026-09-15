---
type: decision
title: Service ownership model
description: How the data platform team assigns and records ownership of a service.
tags: [ownership, catalog]
updated: 2026-06-25
---

## One Owning Team {#owner}

Every service has exactly one owning team recorded in the catalog. Shared ownership is not supported; a service that genuinely needs two owners is really two services.

## Ownership Transfer {#transfer}

Transferring a service requires the receiving team to re-run the [production readiness checklist](../standards/production-readiness.md) against their own on-call setup, not inherit the previous owner's.
