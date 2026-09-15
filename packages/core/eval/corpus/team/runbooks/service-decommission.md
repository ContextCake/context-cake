---
type: runbook
title: Decommissioning a service
description: Steps for retiring a data platform service safely.
tags: [decommission, retire]
updated: 2026-07-06
---

## Draining Traffic {#draining}

Stop routing new traffic to the service and let in-flight work finish before touching infrastructure.

## Reversing Readiness {#reverse}

Undo the [production readiness checklist](../standards/production-readiness.md) items in the opposite order they were added: remove the dashboard link, remove the on-call rotation, then remove the owner entry from the catalog.

## Final Teardown {#teardown}

Delete the repository only after thirty days with zero traffic and zero alerts fired.
