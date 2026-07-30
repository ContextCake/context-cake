---
type: runbook
title: Standard deployment process
description: How the data platform team ships pipeline changes, which differs from the org promotion model.
tags: [deploy, release, pipeline]
updated: 2026-06-25
---

## Pipeline {#pipeline}

Pipeline jobs deploy on drain, not on promotion. A merge builds the image; the running job finishes its current micro-batch, checkpoints, and exits, and the scheduler starts the new version from the same checkpoint.

## Deployment Windows {#windows}

No pipeline deploys during the nightly aggregation window, 01:00 to 05:00 UTC. Outside that, any weekday is fine, including Friday afternoon: a drain-and-restart is not a risky operation for us the way a request-serving rollout is.
